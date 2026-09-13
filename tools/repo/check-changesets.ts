#!/usr/bin/env node
import { checkChangesets } from '../release/lib/changesets-gate.ts';
import { readChangesetStatus } from '../release/lib/workspace.ts';

const kind = await checkChangesets(process.cwd());
for (const release of await readChangesetStatus(process.cwd())) {
  process.stdout.write(
    `changesets: ${release.name} ${release.oldVersion} -> ${release.newVersion} (${release.type})\n`,
  );
}
process.stdout.write(`changesets: OK — ${kind}\n`);
