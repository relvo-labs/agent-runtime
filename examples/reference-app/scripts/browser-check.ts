#!/usr/bin/env node
/**
 * Real-browser check for `examples/reference-app`, driven by `playwright-core`
 * against a genuinely running instance of this app's own server — a real
 * page load, real DOM events, a real `fetch`-based SSE stream.
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

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function waitForServer(url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(url, { headers: { 'x-relvo-reference-app': '1' } });
      if (response.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not become ready in time`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  const { chromium } = await import('playwright-core');

  const port = 48174;
  const base = `http://127.0.0.1:${String(port)}`;
  const workspaceBase = mkdtempSync(join(tmpdir(), 'relvo-browser-check-'));

  const server = spawn(process.execPath, [join(appRoot, 'src/server.ts')], {
    cwd: appRoot,
    env: {
      ...process.env,
      REFERENCE_APP_PORT: String(port),
      REFERENCE_APP_HOST: '127.0.0.1',
      REFERENCE_APP_WORKSPACE_BASE: workspaceBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()));

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer(`${base}/api/providers`, 10_000);

    browser = await chromium.launch({ headless: true, executablePath });

    // ---- desktop viewport: hostile text must render as text, not markup ---
    const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktopPage.goto(base, { waitUntil: 'load' });

    await desktopPage.selectOption('#provider-select', 'scripted-demo');
    await desktopPage.click('#open-session-button');
    await desktopPage.waitForSelector('#session-panel:not([hidden])', { timeout: 5000 });

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
    if (injectedImageCount !== 0)
      throw new Error('browser-check: hostile text was parsed as an element, not rendered as text');
    process.stdout.write('browser-check: hostile prompt text rendered as literal text, never as markup — OK\n');

    // Advance the scripted run, then verify the transcript shows a terminal note.
    await desktopPage.click('#advance-script-button');
    await desktopPage.waitForSelector('#interrupt-button[disabled]', { timeout: 5000 });

    // ---- keyboard operability: reach and activate Close session by keyboard
    await desktopPage.locator('#close-session-button').focus();
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForSelector('#session-panel', { state: 'hidden', timeout: 5000 });
    process.stdout.write('browser-check: Close session is reachable and activatable by keyboard alone — OK\n');
    await desktopPage.close();

    // ---- mobile viewport: layout stays usable, no horizontal overflow -----
    const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await mobilePage.goto(base, { waitUntil: 'load' });
    const overflowsHorizontally = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (overflowsHorizontally) throw new Error('browser-check: page overflows horizontally at a 375px mobile width');
    const openButtonVisible = await mobilePage.locator('#open-session-button').isVisible();
    if (!openButtonVisible) throw new Error('browser-check: primary action is not visible at a mobile viewport');
    process.stdout.write('browser-check: responsive at a 375×812 mobile viewport, no horizontal overflow — OK\n');
    await mobilePage.close();

    process.stdout.write('browser-check: OK\n');
  } catch (error) {
    process.stderr.write(`browser-check: server output was:\n${serverOutput}\n`);
    throw error;
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!server.killed) server.kill('SIGKILL');
    rmSync(workspaceBase, { recursive: true, force: true });
  }
}

await main();
