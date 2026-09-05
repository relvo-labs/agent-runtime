#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

type GateStep = {
  readonly id: string;
  readonly command: readonly string[];
};

export const GATE_STEPS: readonly GateStep[] = [
  { id: 'format', command: ['pnpm', 'format:check'] },
  { id: 'lint', command: ['pnpm', 'lint'] },
  { id: 'typecheck', command: ['pnpm', 'typecheck'] },
  { id: 'engines', command: ['pnpm', 'engines:check'] },
  { id: 'schemas', command: ['pnpm', 'schema:check'] },
  { id: 'skills', command: ['pnpm', 'skills:check'] },
  { id: 'dag', command: ['pnpm', 'dag:check'] },
  { id: 'static', command: ['pnpm', 'static:check'] },
  { id: 'supply-chain', command: ['pnpm', 'supply-chain:check'] },
  { id: 'licenses', command: ['pnpm', 'licenses:check'] },
  { id: 'tests', command: ['pnpm', 'test'] },
  { id: 'build', command: ['pnpm', 'build'] },
  { id: 'artifacts', command: ['pnpm', 'artifacts:check'] },
  { id: 'changesets', command: ['pnpm', 'changeset:status'] },
  { id: 'audit', command: ['pnpm', 'audit', '--prod', '--audit-level=high'] },
];

function run(step: GateStep): void {
  process.stdout.write(`\n[gate:${step.id}] ${step.command.join(' ')}\n`);
  const result = spawnSync(step.command[0]!, step.command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(args: readonly string[]): void {
  if (args.includes('--list')) {
    for (const step of GATE_STEPS) process.stdout.write(`${step.id}\n`);
    return;
  }

  const selectedIndex = args.indexOf('--step');
  if (selectedIndex !== -1) {
    const id = args[selectedIndex + 1];
    const step = GATE_STEPS.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`unknown gate step \`${id ?? ''}\``);
    run(step);
    return;
  }

  for (const step of GATE_STEPS) run(step);
  process.stdout.write(`\n[gate] OK — ${String(GATE_STEPS.length)} steps passed\n`);
}

main(process.argv.slice(2));
