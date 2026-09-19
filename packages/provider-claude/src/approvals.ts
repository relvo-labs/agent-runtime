/**
 * The host approval bridge.
 *
 * The SDK asks one question this adapter can answer faithfully: *may this tool
 * call proceed?* `Options.canUseTool` is called before a tool the session's
 * mode, rules and hooks did not already decide, and the call blocks until it is
 * answered — the prompt has no deadline of its own. That maps exactly onto the
 * neutral approval interaction the protocol already defines, so nothing here
 * invents a wire shape: it raises `interaction.requested`, waits, and turns one
 * settled `InteractionResponse` into one `ClaudePermissionResult`.
 *
 * Four properties this module is responsible for:
 *
 *  1. **One-directional.** A call is allowed only by a valid `approved`/`once`
 *     response. Every other outcome — unknown reference, unsupported kind or
 *     mode, conflicting settlement, teardown — denies or rejects. There is no
 *     auto-allow, no allow-on-timeout and no allow-on-error path.
 *  2. **Exactly once, in process.** A reference settles one callback one time.
 *     An identical redelivery is a no-op (the SPI requires that); a different
 *     answer to a settled reference is refused. This is process-local
 *     settlement, not crash-safe exactly-once.
 *  3. **Nothing native, nothing sensitive, escapes.** The reference is this
 *     adapter's own counter, never the SDK's `toolUseID` or `requestId`. The
 *     approval subject carries a sanitized tool name and nothing else: tool
 *     input routinely holds paths, argv, URLs and workspace contents, and an
 *     event is durable.
 *  4. **No dangling callback.** Every entry belongs to a run. When that run
 *     ends, for any reason, its outstanding callbacks are denied and its
 *     references are forgotten, so a late answer cannot settle anything.
 */

import { agentError, type InteractionResponse, type JsonObject } from '@relvo-labs/agent-protocol';
import { ProviderRejection, type ProviderEventSink } from '@relvo-labs/agent-provider';

import type { ClaudePermissionResult } from './seam.ts';
import { sanitizeToolName } from './translate.ts';

/** Shown to the model when a host denies without saying why. */
const DEFAULT_DENIAL = 'the host denied this tool use';
/** Shown to the model when the run itself went away with the prompt open. */
const TEARDOWN_DENIAL = 'the run that asked for this approval ended before it was answered';
const MAX_DENIAL_CHARS = 2000;

/**
 * Coarse category for a host to render with. Advisory only: it is derived from
 * a model- or MCP-declared tool name, so it describes provider-declared intent
 * and is not an enforced classification (ADR-0009).
 */
const TOOL_CATEGORIES: ReadonlyMap<string, 'command' | 'file_write' | 'network'> = new Map([
  ['Bash', 'command'],
  ['BashOutput', 'command'],
  ['KillShell', 'command'],
  ['Write', 'file_write'],
  ['Edit', 'file_write'],
  ['MultiEdit', 'file_write'],
  ['NotebookEdit', 'file_write'],
  ['WebFetch', 'network'],
  ['WebSearch', 'network'],
]);

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): ProviderRejection {
  return new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

type Entry = {
  /** The run that owns this prompt. Identity only; never inspected here. */
  readonly owner: object;
  readonly settle: (result: ClaudePermissionResult) => void;
  /**
   * The answer already applied, canonicalized. Present means the one callback
   * has been settled: an identical redelivery is a no-op, a different one is a
   * conflict, and neither reaches the callback a second time.
   */
  applied: string | undefined;
};

export type ApprovalRegistry = {
  /**
   * Raise an approval for `owner` and resolve when it is settled. The returned
   * promise is what the SDK is waiting on, so it always resolves — never
   * rejects, and never with `null`, which the SDK reads as "answered out of
   * band" and would leave the tool blocked forever.
   */
  request(owner: object, sink: ProviderEventSink, toolName: string): Promise<ClaudePermissionResult>;
  /** Apply one settled neutral response. Throws `ProviderRejection` if it cannot. */
  settle(providerRef: string, response: InteractionResponse): void;
  /** Deny and forget everything `owner` raised. Safe to call more than once. */
  cancel(owner: object): void;
  /** Deny and forget everything, for session teardown. */
  cancelAll(): void;
};

function denialMessage(reason: string | undefined): string {
  const stated = reason?.trim() ?? '';
  return stated === '' ? DEFAULT_DENIAL : stated.slice(0, MAX_DENIAL_CHARS);
}

/** Canonical form of an applied answer, used to tell redelivery from conflict. */
function appliedKey(response: Extract<InteractionResponse, { kind: 'approval' }>): string {
  return JSON.stringify([response.decision, response.mode ?? null, response.reason ?? null]);
}

export function createApprovalRegistry(): ApprovalRegistry {
  const entries = new Map<string, Entry>();
  let issued = 0;

  function drop(entry: Entry, providerRef: string): void {
    entries.delete(providerRef);
    if (entry.applied === undefined) entry.settle({ behavior: 'deny', message: TEARDOWN_DENIAL });
  }

  function clear(owner: object | undefined): void {
    for (const [providerRef, entry] of [...entries]) {
      if (owner !== undefined && entry.owner !== owner) continue;
      drop(entry, providerRef);
    }
  }

  return {
    request(owner: object, sink: ProviderEventSink, toolName: string): Promise<ClaudePermissionResult> {
      issued += 1;
      // The adapter's own reference. A native `toolUseID` here would put
      // provider identity on a public event and let a caller address the SDK's
      // internals by name.
      const providerRef = `approval-${String(issued)}`;
      const name = sanitizeToolName(toolName);
      const category = TOOL_CATEGORIES.get(toolName) ?? 'tool';

      return new Promise<ClaudePermissionResult>((resolve) => {
        entries.set(providerRef, { owner, settle: resolve, applied: undefined });
        sink.emit({
          payload: {
            type: 'interaction.requested',
            providerRef,
            request: {
              kind: 'approval',
              subject: {
                category,
                // Tool input is deliberately absent: it carries paths, argv,
                // URLs and workspace contents, and this event is durable.
                summary: `claude requests approval to use the \`${name === '' ? 'unnamed' : name}\` tool`,
              },
              // `once` is the only mode the SDK's callback can express: it
              // decides this call. A session or persistent grant would be a
              // permission rule this adapter does not write.
              allowedModes: ['once'],
              riskHint: 'medium',
            },
          },
        });
      });
    },

    settle(providerRef: string, response: InteractionResponse): void {
      const entry = entries.get(providerRef);
      if (entry === undefined) {
        // The reference is caller-controlled text on a durable error, so it is
        // classified, never echoed.
        throw rejection('unknown_interaction', 'the claude adapter has no approval outstanding for that reference');
      }
      if (response.kind !== 'approval') {
        throw rejection(
          'capability_unsupported',
          'the claude adapter bridges approval interactions only; it raises no question',
          { capability: 'interaction.kind', supported: ['approval'], requested: response.kind },
        );
      }
      if (response.decision === 'approved') {
        if (response.mode === undefined) {
          throw rejection('invalid_request', 'an approval must state the mode it was granted under');
        }
        if (response.mode !== 'once') {
          throw rejection(
            'capability_unsupported',
            'the claude adapter grants approval for the one request that asked',
            { capability: 'interaction.approval.modes', supported: ['once'], requested: response.mode },
          );
        }
      }

      // Validation happens before settlement is consumed, so a response this
      // adapter cannot apply leaves the prompt answerable rather than burning
      // the single settlement on an answer nobody can act on.
      const key = appliedKey(response);
      if (entry.applied !== undefined) {
        if (entry.applied === key) return;
        throw rejection('interaction_already_settled', 'this claude approval is already settled');
      }
      entry.applied = key;
      entry.settle(
        response.decision === 'approved'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: denialMessage(response.reason) },
      );
    },

    cancel(owner: object): void {
      clear(owner);
    },

    cancelAll(): void {
      clear(undefined);
    },
  };
}
