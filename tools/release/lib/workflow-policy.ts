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
 *
 * ## Why this check is exhaustive rather than a list of prohibitions
 *
 * An earlier version of this module asserted a set of specific properties and
 * said nothing about everything else. An independent review demonstrated what
 * that costs: `continue-on-error: true` on the gate step, a `shell:` override
 * that never runs the command it declares, an extra unreviewed `run:` in the
 * credential-free job, a job `env` binding a constant instead of the dispatch
 * input, a fabricated `plan-digest` output, and `secrets['NPM_TOKEN']` — an
 * alternate spelling of the one reviewed secret reference — were all accepted
 * with zero findings.
 *
 * Each of those is a different way of saying the same thing: a field that is
 * not asserted is a field an attacker chooses. So the reviewed workflow is
 * described here as an exact structure — allowed keys, exact values, exact
 * command sequences, exact action inputs and an allow-list of the workflow
 * expressions that may appear anywhere in the document — and anything that is
 * not that structure is refused. Changing the workflow therefore means
 * changing this table too, which is precisely the review step that was missing.
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
export const INSTALL_COMMAND = 'pnpm install --frozen-lockfile --ignore-scripts';
/**
 * The gated job may run these commands, in this order, and nothing else.
 *
 * The install is here because npm is a pinned devDependency of this workspace
 * rather than something the runtime supplies: `pnpm/setup` installs Node from
 * the `node` package, which bundles no npm at all. Without this step the gated
 * job has no npm it can prove, and the alternative — falling back to whatever
 * `npm` is on the runner's `PATH` — would publish through a program nothing
 * here pins or reviews, and which is not the one the gate's differential test
 * compared these archives against.
 *
 * It is a frozen, script-free install in a step that holds no credential, and
 * it must stay ahead of both reviewed commands: `verify-staging.ts` proves the
 * tool's identity before the credential exists, and `publish.ts` proves it
 * again before it spawns it.
 */
export const PUBLISH_JOB_COMMANDS: readonly string[] = [INSTALL_COMMAND, VERIFY_STAGING_COMMAND, PUBLISH_COMMAND];
export const SECRET_REFERENCE = '${{ secrets.NPM_TOKEN }}';

const GATE_COMMAND = 'pnpm gate';
const CHANGESETS_BASE_COMMAND = 'git update-ref refs/heads/main refs/remotes/origin/main';

/**
 * Every `${{ … }}` body that may appear anywhere in this workflow.
 *
 * This is what makes `secrets['NPM_TOKEN']` a finding rather than a synonym:
 * the reviewed document contains exactly one secret expression, written one
 * way, and any other expression — however harmless it looks — has not been
 * reviewed in this position.
 */
export const ALLOWED_EXPRESSIONS: readonly string[] = [
  'inputs.source_sha',
  'inputs.packages',
  'inputs.dist_tag',
  'inputs.confirm',
  'github.event_name',
  'github.ref',
  'github.sha',
  'steps.upload.outputs.artifact-id',
  'steps.preflight.outputs.plan-digest',
  'needs.verify.outputs.artifact-id',
  'needs.verify.outputs.plan-digest',
  'secrets.NPM_TOKEN',
];

/** Anything that reads like a secret, in any spelling this YAML can express. */
const SECRET_MENTION_RE = /secrets\s*(?:\.|\[)/iu;
const EXPRESSION_RE = /\$\{\{(?<body>[^}]*)\}\}/gu;

/** Keys a step may carry. Everything else is refused, not ignored. */
const ALLOWED_STEP_KEYS: readonly string[] = ['name', 'id', 'uses', 'with', 'run', 'env'];

/**
 * Step keys that are refused with a reason, because each is a known way to
 * make a release step pass without doing what it says.
 */
const FORBIDDEN_STEP_KEYS: Readonly<Record<string, string>> = {
  if: 'must not be conditional; a release step that can be skipped is a release step that can be green without running',
  'continue-on-error': 'must not suppress its own failure; a release step that may fail silently proves nothing',
  shell: 'must not override the shell; a reviewed command must be run as written, not handed to another program',
  'working-directory': 'must not change its working directory; the reviewed commands run at the repository root',
  'timeout-minutes': 'must not set its own timeout; the reviewed bound is the job timeout',
};

const ALLOWED_JOB_KEYS: readonly string[] = [
  'name',
  'needs',
  'runs-on',
  'timeout-minutes',
  'environment',
  'permissions',
  'outputs',
  'env',
  'steps',
];

const FORBIDDEN_JOB_KEYS: Readonly<Record<string, string>> = {
  if: 'must not be conditional',
  'continue-on-error': 'must not suppress its own failure',
  strategy: 'must not use a matrix strategy; one dispatch is one reviewed publication',
  uses: 'must not delegate to a reusable workflow; the published steps must be reviewable in this file',
  secrets: 'must not forward a secrets block; the credential reaches exactly one step, by name',
  defaults: 'must not set step defaults; every step states its own behaviour',
  concurrency: 'must not set a job-level concurrency group; a publication in flight is never cancelled',
  container: 'must not run in a container image this repository does not review',
  services: 'must not start service containers',
};

const ALLOWED_WORKFLOW_KEYS: readonly string[] = ['concurrency', 'jobs', 'name', 'on', 'permissions'];

type ExpectedStep = {
  /** Action name; the reviewed revision comes from `ALLOWED_ACTIONS`. */
  readonly uses?: string;
  readonly run?: string;
  /** Required `id:`, when a later expression addresses this step's outputs. */
  readonly id?: string;
  /** Exact `with:` mapping, compared key by key. */
  readonly with?: Readonly<Record<string, YamlValue>>;
  /** Exact `env:` mapping. Absent means the step must declare no `env:`. */
  readonly env?: Readonly<Record<string, string>>;
};

type ExpectedJob = {
  readonly needs?: string;
  readonly environment?: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly steps: readonly ExpectedStep[];
};

/** The dispatch facts both jobs re-derive, never interpolated into a command. */
const RELEASE_ENV: Readonly<Record<string, string>> = {
  RELEASE_SOURCE_SHA: '${{ inputs.source_sha }}',
  RELEASE_PACKAGES: '${{ inputs.packages }}',
  RELEASE_DIST_TAG: '${{ inputs.dist_tag }}',
  RELEASE_CONFIRM: '${{ inputs.confirm }}',
  RELEASE_EVENT_NAME: '${{ github.event_name }}',
  RELEASE_REF: '${{ github.ref }}',
  RELEASE_RUNNER_SHA: '${{ github.sha }}',
};

const CHECKOUT_WITH: Readonly<Record<string, YamlValue>> = {
  ref: '${{ inputs.source_sha }}',
  'persist-credentials': false,
  'fetch-depth': 0,
};

const RUNTIME_WITH = (cache: boolean): Readonly<Record<string, YamlValue>> => ({
  version: '11.25.0',
  runtime: 'node@24.20.0',
  cache,
  'require-lockfile': true,
  install: false,
});

/**
 * The reviewed workflow, as a structure.
 *
 * Note what the gated job's download step does *not* carry: a `digest:` input.
 * The pinned `actions/download-artifact` revision declares no such input — it
 * derives the expected hash from the artifact's own metadata — so passing one
 * verified nothing while reading as though it did. `digest-mismatch: error` is
 * the supported control and is required here; the transport is additionally
 * re-established locally, because `verify-staging.ts` re-hashes every tarball
 * and re-derives the plan digest that `verify` recorded as a job output.
 */
const EXPECTED_JOBS: Readonly<Record<string, ExpectedJob>> = {
  verify: {
    permissions: { contents: 'read' },
    outputs: {
      'artifact-id': '${{ steps.upload.outputs.artifact-id }}',
      'plan-digest': '${{ steps.preflight.outputs.plan-digest }}',
    },
    env: RELEASE_ENV,
    steps: [
      { uses: 'actions/checkout', with: CHECKOUT_WITH },
      { run: CHANGESETS_BASE_COMMAND },
      { uses: 'pnpm/setup', with: RUNTIME_WITH(true) },
      { run: INSTALL_COMMAND },
      { run: GATE_COMMAND },
      { id: 'preflight', run: PREFLIGHT_COMMAND },
      {
        id: 'upload',
        uses: 'actions/upload-artifact',
        with: {
          name: STAGING_DIRECTORY,
          path: STAGING_DIRECTORY,
          'if-no-files-found': 'error',
          overwrite: false,
          'include-hidden-files': false,
        },
      },
    ],
  },
  publish: {
    needs: 'verify',
    environment: 'npm-release',
    permissions: { contents: 'read', 'id-token': 'write' },
    env: { ...RELEASE_ENV, RELEASE_PLAN_DIGEST: '${{ needs.verify.outputs.plan-digest }}' },
    steps: [
      { uses: 'actions/checkout', with: CHECKOUT_WITH },
      { uses: 'pnpm/setup', with: RUNTIME_WITH(false) },
      { run: INSTALL_COMMAND },
      {
        uses: 'actions/download-artifact',
        with: {
          'artifact-ids': '${{ needs.verify.outputs.artifact-id }}',
          'digest-mismatch': 'error',
          path: STAGING_DIRECTORY,
        },
      },
      { run: VERIFY_STAGING_COMMAND },
      { run: PUBLISH_COMMAND, env: { NPM_TOKEN: SECRET_REFERENCE } },
    ],
  },
};

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

function describe(value: YamlValue | undefined): string {
  if (value === undefined) return '<absent>';
  if (typeof value === 'string') return value;
  if (value === null) return '<null>';
  if (typeof value === 'object') return Array.isArray(value) ? '<sequence>' : '<mapping>';
  return String(value);
}

/**
 * Compare a parsed mapping against an exact expected mapping. Missing keys,
 * extra keys and changed values are all reported, so the reason a workflow is
 * refused is always the specific field that moved.
 */
function expectExactMapping(
  where: string,
  label: string,
  actual: YamlValue | undefined,
  expected: Readonly<Record<string, YamlValue>>,
  problems: string[],
): void {
  const mapping = asMapping(actual);
  if (mapping === undefined) {
    problems.push(`${where} must declare a ${label} block`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in mapping)) {
      problems.push(`${where} ${label} is missing \`${key}: ${describe(value)}\``);
      continue;
    }
    if (mapping[key] !== value) {
      problems.push(`${where} ${label} \`${key}\` must be \`${describe(value)}\`, found \`${describe(mapping[key])}\``);
    }
  }
  for (const key of Object.keys(mapping)) {
    if (!(key in expected)) problems.push(`${where} ${label} carries unreviewed key \`${key}\``);
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
  if (!keysEqual(dispatch, ['inputs'])) {
    problems.push(`workflow_dispatch must declare only inputs, found: [${mappingKeys(dispatch).join(', ')}]`);
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
    if (!keysEqual(definition, ['description', 'required', 'type'])) {
      problems.push(
        `release input \`${name}\` must declare exactly [description, required, type], found: [${mappingKeys(definition).join(', ')}]`,
      );
    }
  }
}

/**
 * Field-level policy for one step: no key that can suppress, redirect or skip
 * the command, a reviewed action at its reviewed revision, and exactly one
 * reviewable command with no expression interpolated into it.
 */
function checkStepShape(step: Step, problems: string[]): void {
  const where = `job \`${step.job}\` step ${step.index}`;
  for (const [key, reason] of Object.entries(FORBIDDEN_STEP_KEYS)) {
    if (step.mapping[key] !== undefined) problems.push(`${where} ${reason}`);
  }
  for (const key of Object.keys(step.mapping)) {
    if (ALLOWED_STEP_KEYS.includes(key) || key in FORBIDDEN_STEP_KEYS) continue;
    problems.push(`${where} carries unreviewed key \`${key}\``);
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
  if (uses !== undefined && run !== undefined) {
    problems.push(`${where} must either use a pinned action or run a command, not both`);
  }
}

/** Compare one step against the reviewed step in the same position. */
function checkStepAgainstExpectation(
  step: Step | undefined,
  expected: ExpectedStep,
  position: number,
  job: string,
  problems: string[],
): void {
  const where = `job \`${job}\` step ${position}`;
  if (step === undefined) {
    problems.push(
      `${where} is missing; the reviewed job runs \`${expected.uses ?? expected.run ?? '<unknown>'}\` here`,
    );
    return;
  }
  if (expected.uses !== undefined) {
    const uses = asString(step.mapping.uses);
    const action = (uses ?? '').split('@')[0];
    if (action !== expected.uses) {
      problems.push(`${where} must use \`${expected.uses}\`, found \`${uses ?? '<none>'}\``);
      return;
    }
  }
  if (expected.run !== undefined && asString(step.mapping.run) !== expected.run) {
    problems.push(`${where} must run \`${expected.run}\`, found \`${asString(step.mapping.run) ?? '<none>'}\``);
  }
  if (expected.id !== undefined && asString(step.mapping.id) !== expected.id) {
    problems.push(
      `${where} must be addressable as \`${expected.id}\`, found \`${asString(step.mapping.id) ?? '<none>'}\``,
    );
  }
  if (expected.id === undefined && step.mapping.id !== undefined) {
    problems.push(`${where} must not declare an id; nothing reviewed addresses its outputs`);
  }
  if (expected.with === undefined) {
    if (step.mapping.with !== undefined) problems.push(`${where} must not pass action inputs`);
  } else {
    expectExactMapping(where, 'with', step.mapping.with, expected.with, problems);
  }
  if (expected.env === undefined) {
    if (step.mapping.env !== undefined) {
      problems.push(`${where} must not declare env; only the reviewed publication step receives anything`);
    }
  } else {
    expectExactMapping(where, 'env', step.mapping.env, expected.env, problems);
  }
}

/**
 * Exactly one secret expression exists, it is the reviewed spelling, and it
 * reaches exactly one step of the gated job.
 */
function checkSecretConfinement(document: YamlMapping, allSteps: readonly Step[], problems: string[]): void {
  const references: string[] = [];
  collectStrings(document, references);
  const secretStrings = references.filter((value) => SECRET_MENTION_RE.test(value));
  for (const value of secretStrings) {
    if (value !== SECRET_REFERENCE) {
      problems.push(`release workflow references an unreviewed secret expression: ${value}`);
    }
  }

  const secretSteps = allSteps.filter((step) => {
    const env: string[] = [];
    collectStrings(step.mapping.env, env);
    return env.some((value) => SECRET_MENTION_RE.test(value));
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

/**
 * Every `${{ … }}` in the document must be a reviewed expression.
 *
 * This closes the class of bypass where a value that *looks* like the reviewed
 * one — `secrets['NPM_TOKEN']`, `github.event.inputs.source_sha`, an `env.`
 * indirection — is substituted for it.
 */
function checkExpressions(document: YamlMapping, problems: string[]): void {
  const strings: string[] = [];
  collectStrings(document, strings);
  for (const value of strings) {
    for (const match of value.matchAll(EXPRESSION_RE)) {
      const body = (match.groups?.body ?? '').trim();
      if (!ALLOWED_EXPRESSIONS.includes(body)) {
        problems.push(`release workflow evaluates unreviewed expression \`\${{ ${body} }}\``);
      }
    }
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
  if (!keysEqual(job.outputs, ['artifact-id', 'plan-digest'])) {
    problems.push(
      `verify must output exactly [artifact-id, plan-digest], found: [${mappingKeys(job.outputs).join(', ')}]`,
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
  for (const required of [INSTALL_COMMAND, GATE_COMMAND, PREFLIGHT_COMMAND]) {
    if (!commands.includes(required)) problems.push(`verify must run \`${required}\``);
  }
  const gateIndex = commands.indexOf(GATE_COMMAND);
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
  if (job.outputs !== undefined) problems.push('publish must not declare job outputs; nothing consumes them');
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

  const checkout = jobSteps.find((step) => (asString(step.mapping.uses) ?? '').startsWith('actions/checkout@'));
  const checkoutWith = asMapping(checkout?.mapping.with);
  if (checkout === undefined || checkoutWith === undefined) {
    problems.push('publish must check out the repository with explicit inputs');
  } else {
    if (asString(checkoutWith.ref) !== '${{ inputs.source_sha }}') {
      problems.push('publish must check out exactly the dispatched source_sha');
    }
    if (checkoutWith['persist-credentials'] !== false) problems.push('publish checkout must not persist credentials');
    if (checkoutWith['fetch-depth'] !== 0) {
      problems.push('publish checkout must fetch complete history; it re-checks that source_sha is still main’s tip');
    }
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
  if (downloadWith.digest !== undefined) {
    problems.push(
      'publish must not pass a `digest` input; the pinned download action declares none and derives the expected ' +
        'hash from the artifact metadata, so an explicit value reads as a comparison that never happens',
    );
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
  for (const [key, reason] of Object.entries(FORBIDDEN_JOB_KEYS)) {
    if (job[key] !== undefined) problems.push(`job \`${name}\` ${reason}`);
  }
  for (const key of Object.keys(job)) {
    if (ALLOWED_JOB_KEYS.includes(key) || key in FORBIDDEN_JOB_KEYS) continue;
    problems.push(`job \`${name}\` carries unreviewed key \`${key}\``);
  }
  if (asString(job['runs-on']) !== 'ubuntu-latest') problems.push(`job \`${name}\` must run on ubuntu-latest`);
  if (typeof job['timeout-minutes'] !== 'number') problems.push(`job \`${name}\` must set timeout-minutes`);
  return job;
}

/**
 * The exhaustive layer: every reviewed job carries exactly the reviewed env,
 * outputs and step sequence, in order, with exactly the reviewed inputs.
 */
function checkAgainstExpectedShape(
  name: string,
  job: YamlMapping | undefined,
  jobSteps: readonly Step[],
  problems: string[],
): void {
  const expected = EXPECTED_JOBS[name];
  if (job === undefined || expected === undefined) return;

  expectExactMapping(`job \`${name}\``, 'env', job.env, expected.env, problems);
  if (expected.outputs !== undefined) {
    expectExactMapping(`job \`${name}\``, 'outputs', job.outputs, expected.outputs, problems);
  }
  if (jobSteps.length !== expected.steps.length) {
    problems.push(
      `job \`${name}\` must run exactly ${String(expected.steps.length)} reviewed step(s), found ${String(jobSteps.length)}`,
    );
  }
  for (const [index, expectedStep] of expected.steps.entries()) {
    checkStepAgainstExpectation(jobSteps[index], expectedStep, index + 1, name, problems);
  }
}

export function evaluateReleaseWorkflowPolicy(source: string): readonly string[] {
  const parsed = parseYamlSubset(source);
  if (!parsed.ok) return [`release workflow is not in the accepted YAML subset: ${parsed.error}`];
  const document = asMapping(parsed.value);
  if (document === undefined) return ['release workflow must be a mapping'];

  const problems: string[] = [];
  if (!keysEqual(document, ALLOWED_WORKFLOW_KEYS)) {
    problems.push(
      `release workflow top-level keys must be exactly [${ALLOWED_WORKFLOW_KEYS.join(', ')}], found: [${mappingKeys(document).join(', ')}]`,
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
  if (concurrency !== undefined && !keysEqual(document.concurrency, ['cancel-in-progress', 'group'])) {
    problems.push(
      `concurrency must declare exactly [group, cancel-in-progress], found: [${mappingKeys(concurrency).join(', ')}]`,
    );
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
  checkAgainstExpectedShape('verify', verify, verifySteps, problems);
  checkAgainstExpectedShape('publish', publish, publishSteps, problems);
  checkSecretConfinement(document, [...verifySteps, ...publishSteps], problems);
  checkExpressions(document, problems);

  return problems;
}
