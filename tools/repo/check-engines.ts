#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const expected = '^22.18.0 || ^24.11.0 || ^26.0.0';
const problems: string[] = [];
const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setup = 'pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b';

const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } };
if (root.engines?.node !== expected) problems.push(`root engines.node must be ${expected}`);

for (const directory of readdirSync(join(repoRoot, 'packages')).sort()) {
  const path = join(repoRoot, 'packages', directory, 'package.json');
  let manifest: { engines?: { node?: string } };
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
  } catch {
    continue;
  }
  if (manifest.engines?.node !== expected) problems.push(`packages/${directory} engines.node must be ${expected}`);
}

// Trigger policy is repository-wide, not per file. Enumerate the workflow directory so a
// second workflow — a deploy job on push, a scheduled run, a workflow_run listener or an
// unrestricted reusable caller — cannot bypass the policy below by simply not being
// gate.yml. This inventory is the reviewed set; fail closed until a new entry is
// explicitly classified and checked here.
const reviewedWorkflows = ['gate.yml'];
const workflowDirectory = join(repoRoot, '.github/workflows');
const workflowEntries = readdirSync(workflowDirectory, { withFileTypes: true });
const workflowFiles = workflowEntries
  .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort();
for (const entry of workflowEntries) {
  if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) continue;
  problems.push(`.github/workflows contains an unclassified entry: ${entry.name}`);
}
if (workflowFiles.join(',') !== [...reviewedWorkflows].sort().join(',')) {
  problems.push(
    `.github/workflows must contain exactly [${reviewedWorkflows.join(', ')}], found: [${workflowFiles.join(', ')}] — classify and check any new workflow here before adding it`,
  );
}

const workflow = readFileSync(join(workflowDirectory, 'gate.yml'), 'utf8');
const changesetConfig = JSON.parse(readFileSync(join(repoRoot, '.changeset/config.json'), 'utf8')) as {
  baseBranch?: string;
};
for (const version of ['22.18.0', '24.20.0', '26.8.1']) {
  if (!workflow.includes(version)) problems.push(`CI matrix must include Node ${version}`);
}
if (/node-version:\s*['"]?20(?:\.|['"\s])/u.test(workflow) || /\bNode 20\b/u.test(workflow)) {
  problems.push('Node 20 must not be configured or claimed');
}
// The workflow trigger map is policy, not formatting: this repository has exactly one
// validation workflow, which may only be started manually or when a pull request is
// marked ready for review. Parse the `on:` block structurally so a new event or a widened
// pull_request activity list fails here rather than in a hosted run.
const triggerEvents: string[] = [];
const pullRequestTypes: string[] = [];
const workflowLines = workflow.split('\n');
const onIndex = workflowLines.indexOf('on:');
if (onIndex === -1) {
  problems.push('CI must declare a top-level on: block');
} else {
  let currentEvent = '';
  for (const line of workflowLines.slice(onIndex + 1)) {
    if (line.trim() === '') continue;
    if (!line.startsWith('  ')) break;
    const event = /^ {2}([a-z_]+):\s*$/u.exec(line);
    if (event?.[1] !== undefined) {
      currentEvent = event[1];
      triggerEvents.push(currentEvent);
      continue;
    }
    const types = /^ {4}types:\s*\[([^\]]*)\]\s*$/u.exec(line);
    if (types?.[1] !== undefined && currentEvent === 'pull_request') {
      pullRequestTypes.push(
        ...types[1]
          .split(',')
          .map((type) => type.trim())
          .filter(Boolean),
      );
      continue;
    }
    problems.push(`CI trigger block has an unsupported entry: ${line.trim()}`);
  }
}

const allowedEvents = ['pull_request', 'workflow_dispatch'];
const allowedPullRequestTypes = ['ready_for_review'];
if ([...triggerEvents].sort().join(',') !== allowedEvents.join(',')) {
  problems.push(
    `CI triggers must be exactly ${allowedEvents.join(' + ')}, found: ${triggerEvents.join(', ') || '<none>'}`,
  );
}
if (pullRequestTypes.join(',') !== allowedPullRequestTypes.join(',')) {
  problems.push(
    `CI pull_request types must be exactly [${allowedPullRequestTypes.join(', ')}], found: [${pullRequestTypes.join(', ')}]`,
  );
}

// Complete decision table: every row is evaluated against the parsed trigger map.
const triggerExpectations: { event: string; activity?: string; runs: boolean }[] = [
  { event: 'workflow_dispatch', runs: true },
  { event: 'pull_request', activity: 'ready_for_review', runs: true },
  { event: 'pull_request', activity: 'opened', runs: false },
  { event: 'pull_request', activity: 'synchronize', runs: false },
  { event: 'pull_request', activity: 'reopened', runs: false },
  { event: 'pull_request', activity: 'converted_to_draft', runs: false },
  { event: 'pull_request', activity: 'closed', runs: false },
  { event: 'push', runs: false },
  { event: 'schedule', runs: false },
  { event: 'workflow_run', runs: false },
];
for (const { event, activity, runs } of triggerExpectations) {
  const actual = triggerEvents.includes(event) && (activity === undefined || pullRequestTypes.includes(activity));
  if (actual !== runs) {
    const label = activity === undefined ? event : `${event}/${activity}`;
    problems.push(`CI must ${runs ? 'run' : 'not run'} on ${label}`);
  }
}
if (!workflow.includes('timeout-minutes: 30')) problems.push('CI gate must set timeout-minutes: 30');
const checkoutStep = [
  `- uses: ${checkout} # v7.0.1`,
  '        with:',
  '          persist-credentials: false',
  '          fetch-depth: 0',
].join('\n');
if (!workflow.includes(checkoutStep)) {
  problems.push('CI checkout must use the pinned action, disable credentials, and fetch complete history');
}
const changesetBaseStep = [
  '- name: Materialize Changesets base ref',
  '        run: git update-ref refs/heads/main refs/remotes/origin/main',
].join('\n');
if (changesetConfig.baseBranch !== 'main') problems.push('Changesets baseBranch must remain main');
if (!workflow.includes(changesetBaseStep)) problems.push('CI must materialize the configured local main ref');
if (!workflow.includes('permissions:\n  contents: read')) problems.push('CI permissions must remain contents: read');
if (!workflow.includes(setup)) problems.push(`CI toolchain must use ${setup}`);
for (const input of [
  'version: 11.25.0',
  'runtime: node@${{ matrix.node }}',
  'cache: true',
  'require-lockfile: true',
  'install: false',
]) {
  if (!workflow.includes(input)) problems.push(`CI pnpm/setup input is missing: ${input}`);
}
if (/actions\/setup-node|corepack/iu.test(workflow)) {
  problems.push('CI must not depend on actions/setup-node or Corepack');
}
if (!workflow.includes('pnpm install --frozen-lockfile') || !workflow.includes('run: pnpm gate')) {
  problems.push('CI must perform a frozen install and run the canonical gate');
}
for (const match of workflow.matchAll(/^\s*-\s+uses:\s+(\S+)/gmu)) {
  if (!/@[0-9a-f]{40}$/u.test(match[1] ?? '')) {
    problems.push(`CI action must use an immutable SHA: ${match[1] ?? '<missing>'}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`engines: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  'engines: OK — Node 22/24/26 bounded support, immutable CI bootstrap, manual + ready_for_review triggers only\n',
);
