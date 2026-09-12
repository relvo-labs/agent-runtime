/**
 * Structural policy for `.github/workflows/release.yml`.
 *
 * The release workflow is the only file in this repository that can reach a
 * publish credential, so its shape is checked as data rather than as text: the
 * file is parsed (see `yaml.ts`) and every assertion below is made against the
 * parsed document. A permissive text scan would accept a second trigger, a
 * widened permission or a second step that can see `secrets.NPM_TOKEN` simply
 * because it was spelled differently.
 *
 * The rules encode the review decision, not a style preference:
 *
 *   - manual dispatch only, with the four explicit scope inputs;
 *   - the credential-free job proves the artifacts; the gated job publishes
 *     them and does nothing else;
 *   - `id-token: write` exists only where provenance is signed;
 *   - exactly one step in the repository may reference a secret, and its
 *     command is a reviewed script, not an inline shell program.
 */

import {
  asMapping,
  asSequence,
  asString,
  mappingKeys,
  parseYamlSubset,
  type YamlMapping,
  type YamlValue,
} from './yaml.ts';

/** Every action this repository trusts, pinned to a reviewed immutable commit. */
export const ALLOWED_ACTIONS: Readonly<Record<string, string>> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'pnpm/setup': '703c52620218391530e48b9e8870d5c0082e1b9b',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
};

export const REQUIRED_DISPATCH_INPUTS: readonly string[] = ['confirm', 'dist_tag', 'packages', 'source_sha'];

export const STAGING_DIRECTORY = 'release-staging';
export const PREFLIGHT_COMMAND = `node tools/release/preflight.ts --staging ${STAGING_DIRECTORY}`;
export const VERIFY_STAGING_COMMAND = `node tools/release/verify-staging.ts --staging ${STAGING_DIRECTORY}`;
export const PUBLISH_COMMAND = `node tools/release/publish.ts --staging ${STAGING_DIRECTORY}`;
/** The gated job may run these commands and nothing else. */
export const PUBLISH_JOB_COMMANDS: readonly string[] = [VERIFY_STAGING_COMMAND, PUBLISH_COMMAND];
export const SECRET_REFERENCE = '${{ secrets.NPM_TOKEN }}';

type Step = { readonly index: number; readonly job: string; readonly mapping: YamlMapping };

function keysEqual(value: YamlValue | undefined, expected: readonly string[]): boolean {
  return mappingKeys(value).join(',') === [...expected].sort().join(',');
}

function collectStrings(value: YamlValue | undefined, sink: string[]): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  const sequence = asSequence(value);
  if (sequence !== undefined) {
    for (const entry of sequence) collectStrings(entry, sink);
    return;
  }
  const mapping = asMapping(value);
  if (mapping !== undefined) {
    for (const entry of Object.values(mapping)) collectStrings(entry, sink);
  }
}

function steps(job: YamlMapping | undefined, jobName: string, problems: string[]): Step[] {
  const sequence = asSequence(job?.steps);
  if (sequence === undefined) {
    problems.push(`job \`${jobName}\` must declare a steps list`);
    return [];
  }
  const parsed: Step[] = [];
  for (const [index, entry] of sequence.entries()) {
    const mapping = asMapping(entry);
    if (mapping === undefined) {
      problems.push(`job \`${jobName}\` step ${index + 1} is not a mapping`);
      continue;
    }
    parsed.push({ index: index + 1, job: jobName, mapping });
  }
  return parsed;
}

function checkTriggers(document: YamlMapping, problems: string[]): void {
  const on = document.on;
  if (!keysEqual(on, ['workflow_dispatch'])) {
    problems.push(`release triggers must be exactly workflow_dispatch, found: [${mappingKeys(on).join(', ')}]`);
    return;
  }
  const dispatch = asMapping(asMapping(on)?.workflow_dispatch);
  const inputs = asMapping(dispatch?.inputs);
  if (dispatch === undefined || inputs === undefined) {
    problems.push('workflow_dispatch must declare an explicit inputs block');
    return;
  }
  if (!keysEqual(dispatch.inputs, REQUIRED_DISPATCH_INPUTS)) {
    problems.push(
      `release inputs must be exactly [${REQUIRED_DISPATCH_INPUTS.join(', ')}], found: [${mappingKeys(inputs).join(', ')}]`,
    );
  }
  for (const [name, definition] of Object.entries(inputs)) {
    const input = asMapping(definition);
    if (input === undefined) {
      problems.push(`release input \`${name}\` must be a mapping`);
      continue;
    }
    if (input.required !== true) problems.push(`release input \`${name}\` must be required`);
    if (asString(input.type) !== 'string') problems.push(`release input \`${name}\` must be typed string`);
    if ((asString(input.description) ?? '').trim() === '') {
      problems.push(`release input \`${name}\` must carry a description the operator reads before dispatching`);
    }
    if (input.default !== undefined) {
      problems.push(`release input \`${name}\` must not have a default; every release fact is stated explicitly`);
    }
  }
}

function checkStepShape(step: Step, problems: string[]): void {
  const where = `job \`${step.job}\` step ${step.index}`;
  if (step.mapping.if !== undefined) {
    problems.push(
      `${where} must not be conditional; a release step that can be skipped is a release step that can be green without running`,
    );
  }
  const uses = asString(step.mapping.uses);
  if (uses !== undefined) {
    const [action, revision] = uses.split('@');
    const pinned = ALLOWED_ACTIONS[action ?? ''];
    if (pinned === undefined) {
      problems.push(`${where} uses unreviewed action \`${uses}\`; add it to the reviewed action set first`);
    } else if (revision !== pinned) {
      problems.push(`${where} must pin \`${action ?? ''}\` to ${pinned}, found ${revision ?? '<none>'}`);
    }
  }
  const run = asString(step.mapping.run);
  if (run !== undefined) {
    if (run.includes('\n')) problems.push(`${where} must run exactly one reviewed command`);
    if (run.includes('${{')) {
      problems.push(
        `${where} interpolates a workflow expression into a shell command; pass values through env instead`,
      );
    }
  }
  if (uses === undefined && run === undefined) {
    problems.push(`${where} must either use a pinned action or run a command`);
  }
}

function checkSecretConfinement(document: YamlMapping, allSteps: readonly Step[], problems: string[]): void {
  const references: string[] = [];
  collectStrings(document, references);
  const secretStrings = references.filter((value) => value.includes('secrets.'));
  for (const value of secretStrings) {
    if (value !== SECRET_REFERENCE) {
      problems.push(`release workflow references an unreviewed secret expression: ${value}`);
    }
  }

  const secretSteps = allSteps.filter((step) => {
    const env: string[] = [];
    collectStrings(step.mapping.env, env);
    return env.some((value) => value.includes('secrets.'));
  });
  if (secretSteps.length !== 1) {
    problems.push(`exactly one step may receive a secret, found ${secretSteps.length}`);
    return;
  }
  const [secretStep] = secretSteps;
  if (secretStep === undefined) return;
  if (secretStep.job !== 'publish') {
    problems.push(`the credential must only reach the gated publish job, found it in \`${secretStep.job}\``);
  }
  if (!keysEqual(secretStep.mapping.env, ['NPM_TOKEN'])) {
    problems.push(
      `the publish step env must be exactly [NPM_TOKEN], found: [${mappingKeys(secretStep.mapping.env).join(', ')}]`,
    );
  }
  if (asString(secretStep.mapping.run) !== PUBLISH_COMMAND) {
    problems.push(`the credentialed step must run \`${PUBLISH_COMMAND}\``);
  }
  const otherSecretUses = secretStrings.length - 1;
  if (otherSecretUses !== 0) {
    problems.push(`a secret expression appears ${secretStrings.length} times; exactly one reference is permitted`);
  }
}

function checkVerifyJob(job: YamlMapping | undefined, jobSteps: readonly Step[], problems: string[]): void {
  if (job === undefined) return;
  if (job.environment !== undefined) {
    problems.push(
      'the verify job must not be gated by an environment; it exists to prove the artifacts before approval',
    );
  }
  if (!keysEqual(job.permissions, ['contents'])) {
    problems.push(
      `verify permissions must be exactly [contents: read], found: [${mappingKeys(job.permissions).join(', ')}]`,
    );
  } else if (asString(asMapping(job.permissions)?.contents) !== 'read') {
    problems.push('verify permissions must be contents: read');
  }
  if (!keysEqual(job.outputs, ['artifact-digest', 'artifact-id', 'plan-digest'])) {
    problems.push(
      `verify must output exactly [artifact-digest, artifact-id, plan-digest], found: [${mappingKeys(job.outputs).join(', ')}]`,
    );
  }

  const checkout = jobSteps.find((step) => (asString(step.mapping.uses) ?? '').startsWith('actions/checkout@'));
  const checkoutWith = asMapping(checkout?.mapping.with);
  if (checkout === undefined || checkoutWith === undefined) {
    problems.push('verify must check out the repository with explicit inputs');
  } else {
    if (asString(checkoutWith.ref) !== '${{ inputs.source_sha }}') {
      problems.push('verify must check out exactly the dispatched source_sha');
    }
    if (checkoutWith['persist-credentials'] !== false) problems.push('verify checkout must not persist credentials');
    if (checkoutWith['fetch-depth'] !== 0) problems.push('verify checkout must fetch complete history');
  }

  const commands = jobSteps.map((step) => asString(step.mapping.run)).filter((run): run is string => run !== undefined);
  for (const required of ['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm gate', PREFLIGHT_COMMAND]) {
    if (!commands.includes(required)) problems.push(`verify must run \`${required}\``);
  }
  const gateIndex = commands.indexOf('pnpm gate');
  const preflightIndex = commands.indexOf(PREFLIGHT_COMMAND);
  if (gateIndex !== -1 && preflightIndex !== -1 && preflightIndex < gateIndex) {
    problems.push('verify must run the canonical gate before it packs and plans a release');
  }

  const upload = jobSteps.find((step) => (asString(step.mapping.uses) ?? '').startsWith('actions/upload-artifact@'));
  const uploadWith = asMapping(upload?.mapping.with);
  if (upload === undefined || uploadWith === undefined) {
    problems.push('verify must upload the staged release artifacts');
    return;
  }
  if (asString(upload.mapping.id) !== 'upload') problems.push('the upload step must be addressable as `upload`');
  if (asString(uploadWith.path) !== STAGING_DIRECTORY) problems.push(`upload path must be \`${STAGING_DIRECTORY}\``);
  if (asString(uploadWith['if-no-files-found']) !== 'error')
    problems.push('upload must fail when there is nothing to upload');
  if (uploadWith.overwrite !== false) problems.push('upload must not overwrite an existing artifact');
  if (uploadWith['include-hidden-files'] !== false) problems.push('upload must not include hidden files');
}

function checkPublishJob(job: YamlMapping | undefined, jobSteps: readonly Step[], problems: string[]): void {
  if (job === undefined) return;
  const needs =
    asString(job.needs) ??
    asSequence(job.needs)
      ?.map((value) => asString(value) ?? '<non-string>')
      .join(',');
  if (needs !== 'verify') problems.push('publish must depend on verify');
  if (asString(job.environment) !== 'npm-release') {
    problems.push('publish must run in the reviewed `npm-release` environment');
  }
  if (!keysEqual(job.permissions, ['contents', 'id-token'])) {
    problems.push(
      `publish permissions must be exactly [contents: read, id-token: write], found: [${mappingKeys(job.permissions).join(', ')}]`,
    );
  } else {
    const permissions = asMapping(job.permissions);
    if (asString(permissions?.contents) !== 'read') problems.push('publish contents permission must be read');
    if (asString(permissions?.['id-token']) !== 'write')
      problems.push('publish must request id-token: write for provenance');
  }

  const commands = jobSteps.map((step) => asString(step.mapping.run)).filter((run): run is string => run !== undefined);
  if (commands.join('\n') !== PUBLISH_JOB_COMMANDS.join('\n')) {
    problems.push(
      `publish must run exactly [${PUBLISH_JOB_COMMANDS.join(' | ')}] in that order, found: [${commands.join(' | ')}]`,
    );
  }

  const download = jobSteps.find((step) =>
    (asString(step.mapping.uses) ?? '').startsWith('actions/download-artifact@'),
  );
  const downloadWith = asMapping(download?.mapping.with);
  if (download === undefined || downloadWith === undefined) {
    problems.push('publish must download the artifact produced by verify');
    return;
  }
  if (asString(downloadWith['artifact-ids']) !== '${{ needs.verify.outputs.artifact-id }}') {
    problems.push('publish must download the exact artifact id verify produced, not an artifact by name');
  }
  if (asString(downloadWith.digest) !== '${{ needs.verify.outputs.artifact-digest }}') {
    problems.push('publish must pass the digest verify recorded');
  }
  if (asString(downloadWith['digest-mismatch']) !== 'error') {
    problems.push('publish must fail closed on an artifact digest mismatch');
  }
  if (asString(downloadWith.path) !== STAGING_DIRECTORY)
    problems.push(`download path must be \`${STAGING_DIRECTORY}\``);
}

function checkJobEnvelope(jobs: YamlMapping, name: string, problems: string[]): YamlMapping | undefined {
  const job = asMapping(jobs[name]);
  if (job === undefined) {
    problems.push(`release workflow must declare a \`${name}\` job`);
    return undefined;
  }
  if (job.if !== undefined) problems.push(`job \`${name}\` must not be conditional`);
  if (asString(job['runs-on']) !== 'ubuntu-latest') problems.push(`job \`${name}\` must run on ubuntu-latest`);
  if (typeof job['timeout-minutes'] !== 'number') problems.push(`job \`${name}\` must set timeout-minutes`);
  if (asMapping(job.strategy) !== undefined) problems.push(`job \`${name}\` must not use a matrix strategy`);
  return job;
}

export function evaluateReleaseWorkflowPolicy(source: string): readonly string[] {
  const parsed = parseYamlSubset(source);
  if (!parsed.ok) return [`release workflow is not in the accepted YAML subset: ${parsed.error}`];
  const document = asMapping(parsed.value);
  if (document === undefined) return ['release workflow must be a mapping'];

  const problems: string[] = [];
  if (!keysEqual(document, ['concurrency', 'jobs', 'name', 'on', 'permissions'])) {
    problems.push(
      `release workflow top-level keys must be exactly [concurrency, jobs, name, on, permissions], found: [${mappingKeys(document).join(', ')}]`,
    );
  }
  if (asString(document.name) !== 'release') problems.push('release workflow must be named `release`');
  checkTriggers(document, problems);

  if (
    !keysEqual(document.permissions, ['contents']) ||
    asString(asMapping(document.permissions)?.contents) !== 'read'
  ) {
    problems.push('top-level permissions must be exactly contents: read');
  }
  const concurrency = asMapping(document.concurrency);
  if (asString(concurrency?.group) !== 'release') {
    problems.push('release runs must share one constant concurrency group named `release`');
  }
  if (concurrency?.['cancel-in-progress'] !== false) {
    problems.push('a release in flight must never be cancelled by a newer dispatch');
  }

  const jobs = asMapping(document.jobs);
  if (jobs === undefined) return [...problems, 'release workflow must declare jobs'];
  if (!keysEqual(document.jobs, ['publish', 'verify'])) {
    problems.push(`release jobs must be exactly [verify, publish], found: [${mappingKeys(jobs).join(', ')}]`);
  }

  const verify = checkJobEnvelope(jobs, 'verify', problems);
  const publish = checkJobEnvelope(jobs, 'publish', problems);
  const verifySteps = steps(verify, 'verify', problems);
  const publishSteps = steps(publish, 'publish', problems);
  for (const step of [...verifySteps, ...publishSteps]) checkStepShape(step, problems);

  checkVerifyJob(verify, verifySteps, problems);
  checkPublishJob(publish, publishSteps, problems);
  checkSecretConfinement(document, [...verifySteps, ...publishSteps], problems);

  return problems;
}
