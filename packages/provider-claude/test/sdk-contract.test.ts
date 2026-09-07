/**
 * Compatibility proof for the pinned SDK contract.
 *
 * The SDK cannot be installed in this workspace: it is proprietary, so a
 * runtime dependency would fail `tools/repo/check-licenses.ts`, and it carries a
 * ~200 MB per-platform payload that an optional peer deliberately keeps
 * opt-in. Its declaration file cannot be vendored either — non-permissive text
 * is not incorporated into this repository (AGENTS.md §6).
 *
 * What is maintained here instead is a *recorded* description of the exact
 * entry point this adapter uses, authored from the published contract of
 * `@anthropic-ai/claude-agent-sdk@0.3.259` — names and shapes required for
 * interoperability, no copied text. The assertions below are compile-time:
 * `pnpm --filter @relvo-labs/agent-provider-claude typecheck` (and the gate's
 * workspace typecheck, which includes `test/**`) fails if the seam stops
 * matching the recording in either direction.
 *
 * Scope, stated plainly: this proves seam ↔ *recording* agreement, and pins the
 * recording to one SDK version. It cannot prove recording ↔ *shipped SDK*
 * agreement. That step is done out of repository when the pin moves:
 *
 *   npm install --omit=optional @anthropic-ai/claude-agent-sdk@<version> \
 *     @anthropic-ai/sdk @modelcontextprotocol/sdk zod typescript
 *   # then compile `const bound: ClaudeQuery = query;` against src/seam.ts
 *
 * `CLAUDE_AGENT_SDK_VERSION` below fails this test if the pin moves without the
 * recording being re-derived, so the manual step cannot be silently skipped.
 */

import { describe, expect, it } from 'vitest';

import { CLAUDE_AGENT_SDK_VERSION } from '../src/index.ts';
import type {
  ClaudeInterruptReceipt,
  ClaudeMessageUuid,
  ClaudePromptMessage,
  ClaudeQuery,
  ClaudeQueryHandle,
  ClaudeQueryMessage,
  ClaudeQueryOptions,
} from '../src/seam.ts';

/** The SDK release this recording was derived from. */
const RECORDED_SDK_VERSION = '0.3.259';

// ---------------------------------------------------------------------------
// Recorded SDK surface (0.3.259)
// ---------------------------------------------------------------------------

type RecordedUuid = `${string}-${string}-${string}-${string}-${string}`;

/** `SDKUserMessage` — the streaming-input message the adapter submits. */
type RecordedUserMessage = {
  type: 'user';
  message: { role: 'user'; content: string | unknown[] };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  priority?: 'now' | 'next' | 'later';
  uuid?: RecordedUuid;
  session_id?: string;
};

/** `Options` — the fields this adapter sets, with their declared types. */
type RecordedOptions = {
  abortController?: AbortController;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  allowDangerouslySkipPermissions?: boolean;
  permissionPrompts?: 'host' | 'none';
  includePartialMessages?: boolean;
  resume?: string;
};

/** `SDKAssistantMessage`, including the correlation stamps this adapter reads. */
type RecordedAssistantMessage = {
  type: 'assistant';
  message: { role: 'assistant'; content: unknown[] };
  parent_tool_use_id: string | null;
  error?: 'rate_limit' | 'overloaded' | 'unknown';
  uuid: RecordedUuid;
  session_id: string;
  user_message_uuid?: string;
  user_message_uuids?: string[];
};

/** `SDKResultMessage` (success and error variants collapsed to what is read). */
type RecordedResultMessage = {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
  is_error: boolean;
  num_turns: number;
  usage: { input_tokens: number; output_tokens: number };
  errors?: string[];
  uuid: RecordedUuid;
  session_id: string;
  user_message_uuid?: string;
  user_message_uuids?: string[];
};

/** `SDKSystemMessage` — a session-scoped frame the adapter must tolerate. */
type RecordedSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: RecordedUuid;
  session_id: string;
};

type RecordedMessage = RecordedAssistantMessage | RecordedResultMessage | RecordedSystemMessage;

/** `SDKControlInterruptResponse` under the `interrupt_receipt_v1` capability. */
type RecordedInterruptResponse = {
  still_queued: string[];
  cancelled?: string[];
};

/** `Query` — an async generator plus the control requests used here. */
type RecordedQueryHandle = AsyncGenerator<RecordedMessage, void> & {
  interrupt(): Promise<RecordedInterruptResponse | undefined>;
  setPermissionMode(mode: 'default' | 'acceptEdits'): Promise<void>;
};

/** `query({ prompt, options })`. */
type RecordedQuery = (params: {
  prompt: string | AsyncIterable<RecordedUserMessage>;
  options?: RecordedOptions;
}) => RecordedQueryHandle;

// ---------------------------------------------------------------------------
// Compile-time assertions
// ---------------------------------------------------------------------------

/**
 * Assignability, expressed as types so nothing here needs a runtime value: the
 * proof is the typecheck, and `vitest` only carries the version assertion.
 */
type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

/** The official entry point must satisfy the seam with no cast. */
export type SeamAcceptsOfficialQuery = Assert<Assignable<RecordedQuery, ClaudeQuery>>;
/** Every message variant must flow into the translator's input type. */
export type SeamAcceptsEveryMessage = Assert<Assignable<RecordedMessage, ClaudeQueryMessage>>;
/** The live query object must satisfy the handle the session drives. */
export type SeamAcceptsQueryHandle = Assert<Assignable<RecordedQueryHandle, ClaudeQueryHandle>>;
/** The interrupt receipt must be readable through the seam's shape. */
export type SeamReadsInterruptReceipt = Assert<Assignable<RecordedInterruptResponse, ClaudeInterruptReceipt>>;
/** The adapter's stamped prompt must be acceptable as SDK streaming input. */
export type SdkAcceptsStampedPrompt = Assert<Assignable<ClaudePromptMessage, RecordedUserMessage>>;
/** A client uuid must be acceptable where the SDK declares `UUID`. */
export type SdkAcceptsClientUuid = Assert<Assignable<ClaudeMessageUuid, RecordedUuid>>;
/** The options the adapter builds must be acceptable to the SDK's `Options`. */
export type SdkAcceptsAdapterOptions = Assert<Assignable<ClaudeQueryOptions, RecordedOptions>>;

describe('pinned SDK contract', () => {
  it('records the SDK version the seam was derived from', () => {
    // A moved pin without a re-derived recording is a silent compatibility
    // claim. Fail here so the out-of-repository check above is re-run.
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(RECORDED_SDK_VERSION);
  });

  it('states where the recording cannot reach', () => {
    // Deliberate limitation, kept visible: this file proves seam ↔ recording,
    // never recording ↔ the SDK on disk, which policy keeps out of this
    // workspace. The header documents the out-of-repository step.
    expect(RECORDED_SDK_VERSION).toBe('0.3.259');
  });
});
