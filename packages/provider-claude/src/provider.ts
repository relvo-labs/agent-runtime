/**
 * The Claude adapter.
 *
 * Shape of the integration, and why:
 *
 *   session  one SDK `query()` with **streaming input**. The query is the
 *            conversation: successive runs push further user messages into the
 *            same stream, so a turn keeps the context of the one before it
 *            without this adapter persisting or replaying anything.
 *   run      one user message and the messages the SDK produces until its
 *            `result`. Exactly one terminal outcome, always.
 *   interrupt the SDK's cooperative control request. It ends the turn; it does
 *            not end the query, which is why the session survives it.
 *   dispose  close the input stream, abort, and tear the query down.
 *
 * Streaming input is also what makes `interrupt()` available at all — the SDK
 * supports control requests only in that mode — so the alternative (a fresh
 * one-shot query per run) would have forced `interrupt.mode: 'unsupported'`.
 *
 * Native identity (session ids, message uuids, tool-use ids, the query handle,
 * the child process) stays inside this module. Nothing below emits it.
 */

import { isAbsolute } from 'node:path';

import { agentError, type InteractionResponse, type JsonObject, type TurnInput } from '@relvo-labs/agent-protocol';
import {
  ProviderRejection,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderRun,
  type ProviderRunRequest,
  type ProviderRunTermination,
  type ProviderSession,
  type ProviderSessionInit,
} from '@relvo-labs/agent-provider';

import { loadClaudeQuery, CLAUDE_AGENT_SDK_PACKAGE } from './binding.ts';
import { ClaudeSessionOptionsSchema, type ClaudeProviderOptions, type ClaudeSessionOptions } from './options.ts';
import { createRunTranslator, redact } from './translate.ts';
import type { ClaudePromptMessage, ClaudeQuery, ClaudeQueryHandle, ClaudeQueryOptions } from './seam.ts';

export const CLAUDE_PROVIDER_ID = 'claude';
/** This adapter's own version, reported for diagnostics. Not the wire version. */
export const CLAUDE_ADAPTER_VERSION = '0.1.0';
/** The SDK line the query seam in `seam.ts` mirrors. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.259';

const PART_SEPARATOR = '\n\n';
const MAX_REASON_CHARS = 300;

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): never {
  throw new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

// ---------------------------------------------------------------------------
// Streaming input
// ---------------------------------------------------------------------------

type PromptStream = {
  readonly messages: AsyncIterable<ClaudePromptMessage>;
  push(text: string): void;
  close(): void;
};

function createPromptStream(): PromptStream {
  const queued: ClaudePromptMessage[] = [];
  const waiting: ((result: IteratorResult<ClaudePromptMessage, void>) => void)[] = [];
  let closed = false;

  return {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          const result = await new Promise<IteratorResult<ClaudePromptMessage, void>>((resolve) => {
            waiting.push(resolve);
          });
          if (result.done === true) return;
          yield result.value;
        }
      },
    },
    push(text: string): void {
      const message: ClaudePromptMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      };
      const waiter = waiting.shift();
      if (waiter === undefined) queued.push(message);
      else waiter({ done: false, value: message });
    },
    close(): void {
      if (closed) return;
      closed = true;
      let waiter = waiting.shift();
      while (waiter !== undefined) {
        waiter({ done: true, value: undefined });
        waiter = waiting.shift();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseSessionOptions(options: JsonObject): ClaudeSessionOptions {
  const parsed = ClaudeSessionOptionsSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  rejection(
    'invalid_request',
    `claude session options are invalid${issue === undefined ? '' : `: ${issue.path.join('.') || '<root>'} ${issue.message}`}`,
  );
}

function queryOptionsFor(
  root: string,
  defaults: ClaudeProviderOptions,
  overrides: ClaudeSessionOptions,
  abortController: AbortController,
): ClaudeQueryOptions {
  const model = overrides.model ?? defaults.model;
  const maxTurns = overrides.maxTurns ?? defaults.maxTurns;
  const permissionMode = overrides.permissionMode ?? defaults.permissionMode;
  const allowedTools = overrides.allowedTools ?? defaults.allowedTools;
  const disallowedTools = overrides.disallowedTools ?? defaults.disallowedTools;

  return {
    cwd: root,
    abortController,
    // This adapter declares no interaction capability. Anything that would ask
    // a human must fail closed instead of hanging a run nobody can answer.
    permissionPrompts: 'none',
    ...(model === undefined ? {} : { model }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
    ...(disallowedTools === undefined ? {} : { disallowedTools: [...disallowedTools] }),
    // The SDK requires this acknowledgement alongside a bypassing mode. It
    // records the caller's intent; it grants nothing the process lacked.
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
  };
}

function promptTextFor(input: TurnInput): string {
  const texts: string[] = [];
  for (const part of input.parts) {
    if (part.type !== 'text') {
      rejection(
        'capability_unsupported',
        `claude adapter accepts \`text\` turn input only; \`${part.type}\` parts are not translated`,
        { capability: 'turnInput.parts', supported: ['text'], requested: part.type },
      );
    }
    texts.push(part.text);
  }
  return texts.join(PART_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type ActiveRun = {
  readonly translator: ReturnType<typeof createRunTranslator>;
  readonly request: ProviderRunRequest;
  settle(termination: ProviderRunTermination): void;
  terminated: boolean;
  interruptDelivered: boolean;
  interruptReason: string | undefined;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function createSessionFor(
  query: ClaudeQuery,
  defaults: ClaudeProviderOptions,
  init: ProviderSessionInit,
  overrides: ClaudeSessionOptions,
): ProviderSession {
  const abortController = new AbortController();
  const prompts = createPromptStream();

  let handle: ClaudeQueryHandle;
  try {
    handle = query({
      prompt: prompts.messages,
      options: queryOptionsFor(init.workspace.root, defaults, overrides, abortController),
    });
  } catch (error) {
    throw new ProviderRejection(
      agentError('provider_unavailable', `claude query could not be started: ${explainError(error)}`),
    );
  }

  let active: ActiveRun | undefined;
  let pumping = false;
  let streamClosed = false;
  let disposing = false;
  let disposed = false;

  function settle(termination: ProviderRunTermination): void {
    const run = active;
    if (run === undefined || run.terminated) return;
    run.terminated = true;
    active = undefined;
    run.settle(termination);
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        for await (const message of handle) {
          const run = active;
          if (run === undefined) continue;
          const translation = run.translator.translate(message);
          for (const event of translation.events) run.request.sink.emit(event);
          if (translation.termination === undefined) continue;
          settle(
            run.interruptDelivered
              ? {
                  outcome: 'interrupted',
                  ...(run.interruptReason === undefined ? {} : { reason: run.interruptReason }),
                }
              : translation.termination,
          );
        }
        streamClosed = true;
        // A stream that ends because the caller is disposing is not a fault,
        // and disposal owns the terminal outcome of any run still in flight.
        if (disposing) return;
        init.sink.emit({
          payload: { type: 'diagnostic', level: 'warning', message: 'claude query stream ended' },
        });
        settle({
          outcome: 'failed',
          error: agentError('provider_contract_violation', 'claude query ended without a result for the active run'),
        });
      } catch (error) {
        streamClosed = true;
        if (disposing) return;
        init.sink.emit({
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: `claude query stream failed: ${explainError(error)}`,
          },
        });
        settle({
          outcome: 'failed',
          error: agentError('provider_unavailable', `claude query stream failed: ${explainError(error)}`),
        });
      }
    })();
  }

  function beginRun(request: ProviderRunRequest): ProviderRun {
    if (disposed) rejection('session_closed', 'claude provider session is disposed');
    if (streamClosed) rejection('provider_unavailable', 'the claude query for this session has ended');
    if (active !== undefined) {
      rejection('illegal_state_transition', 'the claude adapter runs one turn per session at a time');
    }
    const text = promptTextFor(request.input);

    let settleCompletion!: (termination: ProviderRunTermination) => void;
    const completion = new Promise<ProviderRunTermination>((resolve) => {
      settleCompletion = resolve;
    });
    const run: ActiveRun = {
      translator: createRunTranslator(),
      request,
      settle: settleCompletion,
      terminated: false,
      interruptDelivered: false,
      interruptReason: undefined,
    };
    active = run;
    prompts.push(text);
    pump();

    return {
      completion,
      async interrupt(reason?: string): Promise<void> {
        // Terminal, or already asked: both are no-ops, never a second stop.
        if (run.terminated || run.interruptDelivered) return;
        try {
          await handle.interrupt();
        } catch (error) {
          throw new ProviderRejection(
            agentError('provider_rejected', `claude interrupt failed: ${explainError(error)}`),
          );
        }
        run.interruptDelivered = true;
        run.interruptReason = reason === undefined ? undefined : reason.slice(0, MAX_REASON_CHARS);
      },
    };
  }

  return {
    startRun(request: ProviderRunRequest): Promise<ProviderRun> {
      // Every rejection must reach the runtime as a rejected promise, never as
      // a synchronous throw at the call site.
      try {
        return Promise.resolve(beginRun(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    respondToInteraction(providerRef: string, _response: InteractionResponse): Promise<void> {
      // The adapter never raises an interaction, so any reference is unknown.
      // Silently accepting one would let a caller believe an approval landed.
      return Promise.reject(
        new ProviderRejection(
          agentError('unknown_interaction', 'the claude adapter does not raise interactions', {
            details: { providerRef: providerRef.slice(0, 200) },
          }),
        ),
      );
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposing = true;
      prompts.close();
      abortController.abort();
      try {
        await handle.return?.();
      } catch (error) {
        // Truthful failure: `disposed` stays false so an identical retry can
        // finish the teardown.
        throw new ProviderRejection(
          agentError('provider_rejected', `claude query teardown failed: ${explainError(error)}`),
        );
      }
      disposed = true;
      streamClosed = true;
      settle({ outcome: 'interrupted', reason: 'claude provider session disposed' });
    },
  };
}

function explainError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
  return redact(message).slice(0, MAX_REASON_CHARS);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Create the Claude provider adapter.
 *
 * Register it with a runtime by id; the runtime never imports this package.
 * Omit `options.query` to bind the official SDK, or pass one to run against a
 * host-managed or deterministic implementation.
 */
export function createClaudeProvider(options: ClaudeProviderOptions = {}): AgentProvider {
  const descriptor = defineProviderDescriptor({
    providerId: CLAUDE_PROVIDER_ID,
    providerVersion: CLAUDE_ADAPTER_VERSION,
    displayName: 'Claude Agent SDK',
    run: {
      // The SDK stops at its next safe point and still reports the turn.
      interrupt: { mode: 'cooperative', deliversPartialOutput: true, sessionRemainsUsable: true },
      streaming: {
        messageDeltas: true,
        toolActivity: true,
        // Token accounting arrives with the SDK's terminal result only.
        incrementalUsage: false,
      },
      maxConcurrentRunsPerSession: 1,
    },
    // No approval or question is bridged, so none is claimed. Permission
    // prompts inside the SDK fail closed instead of waiting for an answer.
    interaction: { approval: {}, question: {}, settlementTimeoutMs: null },
    workspace: { requires: 'directory', acceptsOwnership: ['borrowed', 'managed'], writes: true },
    recovery: {},
    extensions: {
      sdkPackage: CLAUDE_AGENT_SDK_PACKAGE,
      sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      /** Deltas arrive per assistant message, not per token. */
      textGranularity: 'message',
      supportedInputParts: ['text'],
    },
  });

  return {
    describe: () => descriptor,
    async createSession(init: ProviderSessionInit): Promise<ProviderSession> {
      const overrides = parseSessionOptions(init.options);
      if (init.workspace.root === '' || !isAbsolute(init.workspace.root)) {
        rejection('invalid_request', 'the claude adapter requires an absolute workspace root');
      }
      const query = options.query ?? (await loadClaudeQuery());
      return createSessionFor(query, options, init, overrides);
    },
  };
}
