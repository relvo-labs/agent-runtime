/** Release inventory, without the CLI's independent feature-coverage assertion. */
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import { resolve } from 'node:path';

type ChangesetState = {
  packages: Awaited<ReturnType<typeof getPackages>>;
  config: NonNullable<Awaited<ReturnType<typeof readConfig>>['config']>;
  changesets: Awaited<ReturnType<typeof readChangesets>>;
  preState: Awaited<ReturnType<typeof readPreState>>;
  plan: ReturnType<typeof assembleReleasePlan>;
};

export async function readChangesetState(repoRoot: string): Promise<ChangesetState> {
  const packages = await getPackages(repoRoot);
  if (packages.rootDir !== resolve(repoRoot)) throw new Error('Changesets resolved a different workspace root');
  const result = await readConfig(repoRoot, packages);
  if (result.errors !== undefined) throw new Error(`Invalid Changesets config: ${result.errors.join('; ')}`);
  const changesets = await readChangesets(repoRoot);
  const preState = await readPreState(repoRoot);
  const plan = assembleReleasePlan(changesets, packages, result.config, preState);
  return { packages, config: result.config, changesets, preState, plan };
}
