import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolvePackage = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests exercise SOURCE. Published-artifact behaviour is proven separately
    // by `pnpm artifacts:check` against packed tarballs.
    alias: {
      '@relvo-labs/agent-protocol': resolvePackage('./packages/protocol/src/index.ts'),
      '@relvo-labs/agent-executor': resolvePackage('./packages/executor/src/index.ts'),
      '@relvo-labs/agent-provider/testing': resolvePackage('./packages/provider/src/testing/index.ts'),
      '@relvo-labs/agent-provider': resolvePackage('./packages/provider/src/index.ts'),
      '@relvo-labs/agent-provider-codex': resolvePackage('./packages/provider-codex/src/index.ts'),
      '@relvo-labs/agent-provider-claude': resolvePackage('./packages/provider-claude/src/index.ts'),
      '@relvo-labs/agent-workspace': resolvePackage('./packages/workspace/src/index.ts'),
      '@relvo-labs/agent-workspace-git': resolvePackage('./packages/workspace-git/src/index.ts'),
      '@relvo-labs/agent-runtime': resolvePackage('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    // Root-relative patterns would resolve against the *package* directory when
    // a package script runs `vitest run test`, so the documented
    // `pnpm --filter <package> test` command would silently match nothing and
    // exit non-zero. These patterns select the same files from the workspace
    // root and from inside any one package.
    include: ['**/test/**/*.test.ts', '**/tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tools/skills/__fixtures__/**'],
    environment: 'node',
    // Contract tests must be deterministic; a passing run must not depend on
    // wall-clock timing. Anything slower than this is hiding a real wait.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'tools/**/*.ts'],
      exclude: ['**/index.ts', 'tools/skills/__fixtures__/**'],
    },
  },
});
