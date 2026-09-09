#!/usr/bin/env node
/**
 * Real-browser check for `examples/reference-app`, driven by `playwright-core`
 * against a genuinely running instance of this app's own server — a real
 * page load, real DOM events, a real `fetch`-based SSE stream, and real
 * button clicks (including a genuine in-flight **Interrupt run** click, on
 * both a desktop and a mobile viewport — not merely an assertion that the
 * button *ends up* disabled after the fact, which would pass even if the
 * button had been wrongly disabled — or wrongly never enabled — the whole
 * time).
 *
 * NOT part of `pnpm gate`: the canonical gate must stay deterministic and
 * runnable with no environment-dependent skip path (see
 * `.agents/skills/local-ci-parity/SKILL.md`), and this check depends on a
 * browser binary this workspace does not install (`playwright-core` ships no
 * postinstall download — see the `pnpm-workspace.yaml` catalog comment).
 * Supply one explicitly:
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome pnpm --filter @relvo-labs/reference-app browser-check
 *
 * If a Playwright browser cache already exists (`~/.cache/ms-playwright` or
 * `PLAYWRIGHT_BROWSERS_PATH`), point the variable at the `chrome`/
 * `headless_shell` binary inside it. Missing the variable is a clear,
 * immediate failure — never a silent skip that would look like a pass.
 *
 * Credential-free and network-free beyond loopback: no model, no API key.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Page } from 'playwright-core';

const appRoot = new URL('..', import.meta.url).pathname;

function requireChromiumExecutable(): string {
  const value = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!value) {
    process.stderr.write(
      'browser-check: PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set — this check requires an explicit,\n' +
        'host-supplied Chromium/Chrome executable path (see the comment at the top of\n' +
        'examples/reference-app/scripts/browser-check.ts). Not running one is a clean failure, not a skip.\n',
    );
    process.exit(1);
  }
  return value;
}

const executablePath = requireChromiumExecutable();

// ---------------------------------------------------------------------------
// A managed child process whose readiness is correlated to ITS OWN stdout,
// never to a fixed, possibly-already-occupied port. See `tools/repo/
// check-app-pack.ts`'s identical helper for the full rationale; duplicated
// here rather than shared because this script and that one live on opposite
// sides of a deliberate import boundary (this app never depends on
// `tools/repo`, and `tools/repo` is typechecked by the root project, which
// deliberately excludes `examples/**`).
// ---------------------------------------------------------------------------

type ManagedServer = {
  readonly baseUrl: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  output(): string;
  stop(): Promise<void>;
};

const READY_LINE = /listening on (http:\/\/\S+)/u;
const SHUTDOWN_GRACE_MS = 3000;

async function startManagedServer(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readyDeadlineMs: number;
}): Promise<ManagedServer> {
  const child = spawn(process.execPath, options.args, {
    cwd: options.cwd,
    env: { ...options.env, REFERENCE_APP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exitPromise = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      exited = true;
      resolveExit();
    });
  });

  const baseUrl = await new Promise<string>((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error(`server did not report readiness within ${String(options.readyDeadlineMs)}ms:\n${output}`));
    }, options.readyDeadlineMs);
    function detach(): void {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
    }
    function onData(): void {
      if (settled) return;
      const match = READY_LINE.exec(output);
      if (match === null) return;
      settled = true;
      detach();
      resolveReady(match[1]!);
    }
    function onExit(): void {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error(`server process exited before it reported readiness:\n${output}`));
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData(); // in case the line already arrived before these listeners attached
  });

  return {
    baseUrl,
    child,
    output: () => output,
    async stop(): Promise<void> {
      if (exited) return;
      child.kill('SIGTERM');
      const exitedGracefully = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((r) => {
          setTimeout(() => {
            r(false);
          }, SHUTDOWN_GRACE_MS);
        }),
      ]);
      if (!exitedGracefully) {
        child.kill('SIGKILL');
        await Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

async function badgeText(page: Page, elementId: string): Promise<string> {
  return page
    .locator(`#${elementId}`)
    .textContent()
    .then((text) => (text ?? '').trim());
}

async function waitForBadgeText(page: Page, elementId: string, expected: string, timeout = 5000): Promise<void> {
  await page.waitForFunction(
    ({ id, expected: expectedText }) => document.getElementById(id)?.textContent?.trim() === expectedText,
    { id: elementId, expected },
    { timeout },
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`browser-check: ${message}`);
}

/**
 * Opens a session, drives one full turn → in-flight interrupt → followup →
 * advance → close cycle, and asserts every intermediate state a human would
 * actually see — not only the final one. Used on both viewports so a
 * viewport-specific layout regression cannot hide behind "desktop already
 * covers the state machine".
 */
async function exerciseFullSessionLifecycle(page: Page, label: string): Promise<void> {
  await page.selectOption('#provider-select', 'scripted-demo');
  await page.click('#open-session-button');
  await page.waitForSelector('#session-panel:not([hidden])', { timeout: 5000 });

  // The session badge must reflect the SDK's own state promptly — not stay
  // on the client-side placeholder set optimistically before any event
  // arrived. Missing the `session.opened` event handler left this stuck on
  // "opening" forever.
  await waitForBadgeText(page, 'session-state-badge', 'ready');
  assert(await page.locator('#run-state-badge').isHidden(), `${label}: run badge must be hidden before any turn`);
  assert(await page.locator('#interrupt-button').isDisabled(), `${label}: Interrupt must start disabled (no run yet)`);

  await page.fill('#turn-input', 'first message — must genuinely stay running until Advance');
  await page.click('#send-turn-button');

  // The load-bearing assertion the previous check never made: Interrupt must
  // become enabled — and the run badge must show `running` — as soon as the
  // run starts, not only "end up disabled after Advance". A check that only
  // asserts the post-Advance disabled state passes even if the button were
  // never enabled at all.
  await waitForBadgeText(page, 'run-state-badge', 'running');
  assert(!(await page.locator('#interrupt-button').isDisabled()), `${label}: Interrupt must be enabled while running`);

  // A genuine click — not a state inspection — is what actually exercises
  // the handler.
  await page.click('#interrupt-button');
  await waitForBadgeText(page, 'run-state-badge', 'interrupted');
  assert(await page.locator('#interrupt-button').isDisabled(), `${label}: Interrupt must disable once terminal`);

  // A followup turn on the same session must work right after an interrupt —
  // interrupting a run never ends the session.
  await page.fill('#turn-input', 'followup message after interrupt');
  await page.click('#send-turn-button');
  await waitForBadgeText(page, 'run-state-badge', 'running');

  await page.click('#advance-script-button');
  await waitForBadgeText(page, 'run-state-badge', 'succeeded');
  assert(await page.locator('#interrupt-button').isDisabled(), `${label}: Interrupt must stay disabled once succeeded`);

  process.stdout.write(`browser-check: [${label}] full ready→running→interrupted→followup→succeeded cycle — OK\n`);
}

async function main(): Promise<void> {
  const { chromium } = await import('playwright-core');

  const workspaceBase = mkdtempSync(join(tmpdir(), 'relvo-browser-check-'));
  const server = await startManagedServer({
    args: [join(appRoot, 'src/server.ts')],
    cwd: appRoot,
    env: { ...process.env, REFERENCE_APP_HOST: '127.0.0.1', REFERENCE_APP_WORKSPACE_BASE: workspaceBase },
    readyDeadlineMs: 10_000,
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const base = server.baseUrl;
    browser = await chromium.launch({ headless: true, executablePath });

    // ======================================================================
    // Desktop viewport
    // ======================================================================
    const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktopPage.goto(base, { waitUntil: 'load' });

    await desktopPage.selectOption('#provider-select', 'scripted-demo');
    await desktopPage.click('#open-session-button');
    await desktopPage.waitForSelector('#session-panel:not([hidden])', { timeout: 5000 });
    await waitForBadgeText(desktopPage, 'session-state-badge', 'ready');

    const hostileText = '<img src=x onerror="window.__relvoXssFired = true">';
    await desktopPage.fill('#turn-input', hostileText);
    await desktopPage.click('#send-turn-button');
    await desktopPage.waitForFunction(
      (text) => document.getElementById('transcript')?.textContent?.includes(text) ?? false,
      hostileText,
      { timeout: 5000 },
    );

    const xssFired = await desktopPage.evaluate(() =>
      Boolean((window as unknown as { __relvoXssFired?: boolean }).__relvoXssFired),
    );
    if (xssFired) throw new Error('browser-check: hostile text executed as script — unsafe rendering');

    const injectedImageCount = await desktopPage.evaluate(() => document.querySelectorAll('#transcript img').length);
    if (injectedImageCount !== 0) {
      throw new Error('browser-check: hostile text was parsed as an element, not rendered as text');
    }
    process.stdout.write('browser-check: hostile prompt text rendered as literal text, never as markup — OK\n');

    // This message never advances (no `#advance-script-button` click yet), so
    // it is still genuinely in flight — real material for the interrupt
    // click below, not a run that already finished.
    await waitForBadgeText(desktopPage, 'run-state-badge', 'running');
    assert(
      !(await desktopPage.locator('#interrupt-button').isDisabled()),
      'desktop: Interrupt must be enabled while the hostile-text run is genuinely still running',
    );
    await desktopPage.click('#interrupt-button');
    await waitForBadgeText(desktopPage, 'run-state-badge', 'interrupted');

    // Real followup + advance + click-driven close, asserting every
    // intermediate badge state, not only the end state.
    await desktopPage.fill('#turn-input', 'followup after the hostile-text run was interrupted');
    await desktopPage.click('#send-turn-button');
    await waitForBadgeText(desktopPage, 'run-state-badge', 'running');
    await desktopPage.click('#advance-script-button');
    await waitForBadgeText(desktopPage, 'run-state-badge', 'succeeded');

    // ---- keyboard operability: reach and activate Close session by keyboard
    await desktopPage.locator('#close-session-button').focus();
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForSelector('#session-panel', { state: 'hidden', timeout: 5000 });
    assert(
      (await badgeText(desktopPage, 'session-state-badge')) === '—',
      'desktop: session badge must reset after close, not keep showing the closed session’s last state',
    );
    assert(
      await desktopPage.locator('#run-state-badge').isHidden(),
      'desktop: run badge must be hidden again after close',
    );
    process.stdout.write('browser-check: Close session is reachable and activatable by keyboard alone — OK\n');

    // ---- close/reopen: a fresh session must never show a stale badge from
    // the one just closed (the exact P1/P2 regression this check now guards).
    await exerciseFullSessionLifecycle(desktopPage, 'desktop-reopened');
    await desktopPage.click('#close-session-button');
    await desktopPage.waitForSelector('#session-panel', { state: 'hidden', timeout: 5000 });
    await desktopPage.close();

    // ======================================================================
    // Mobile viewport — the same real interrupt click, not only a layout check
    // ======================================================================
    const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await mobilePage.goto(base, { waitUntil: 'load' });

    const emptyShellOverflows = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (emptyShellOverflows) throw new Error('browser-check: empty page overflows horizontally at a 375px width');
    const openButtonVisible = await mobilePage.locator('#open-session-button').isVisible();
    if (!openButtonVisible) throw new Error('browser-check: primary action is not visible at a mobile viewport');

    // The layout must also stay usable once a session is actually active —
    // badges, run controls, and transcript all rendering — not only on the
    // near-empty initial shell.
    await exerciseFullSessionLifecycle(mobilePage, 'mobile-active');
    const activeSessionOverflows = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (activeSessionOverflows) {
      throw new Error('browser-check: page overflows horizontally at a 375px width with an active session');
    }
    process.stdout.write(
      'browser-check: responsive at a 375×812 mobile viewport with an active session, no horizontal overflow — OK\n',
    );
    await mobilePage.click('#close-session-button');
    await mobilePage.waitForSelector('#session-panel', { state: 'hidden', timeout: 5000 });
    await mobilePage.close();

    process.stdout.write('browser-check: OK\n');
  } catch (error) {
    process.stderr.write(`browser-check: server output was:\n${server.output()}\n`);
    throw error;
  } finally {
    await browser?.close();
    // Genuinely awaited (including the SIGKILL escalation if needed) before
    // the workspace directory this process may still hold a handle into is
    // removed below.
    await server.stop();
    rmSync(workspaceBase, { recursive: true, force: true });
  }
}

await main();
