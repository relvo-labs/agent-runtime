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

import { randomUUID } from 'node:crypto';
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
import { classifyThrown, correlationStampsOf, createRunTranslator } from './translate.ts';
import type {
  ClaudeMessageUuid,
  ClaudePromptMessage,
  ClaudeQuery,
  ClaudeQueryHandle,
  ClaudeQueryOptions,
} from './seam.ts';

export const CLAUDE_PROVIDER_ID = 'claude';
/** This adapter's own version, reported for diagnostics. Not the wire version. */
export const CLAUDE_ADAPTER_VERSION = '0.1.0';
/** The SDK line the query seam in `seam.ts` mirrors. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.259';

const PART_SEPARATOR = '\n\n';
const MAX_REASON_CHARS = 300;
const DISPOSED_REASON = 'claude provider session disposed';

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): never {
  throw new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

// ---------------------------------------------------------------------------
// Streaming input
// ---------------------------------------------------------------------------

type PromptStream = {
  readonly messages: AsyncIterable<ClaudePromptMessage>;
  push(text: string, uuid: ClaudeMessageUuid): void;
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
    push(text: string, uuid: ClaudeMessageUuid): void {
      const message: ClaudePromptMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        // Stamping the client uuid is what makes this turn attributable and
        // listable in an interrupt receipt. It never leaves the adapter.
        uuid,
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
  /** Client uuid of the message submitted for this run. Never emitted. */
  readonly uuid: ClaudeMessageUuid;
  readonly translator: ReturnType<typeof createRunTranslator>;
  readonly request: ProviderRunRequest;
  settle(termination: ProviderRunTermination): void;
  terminated: boolean;
  /**
   * Set synchronously before the interrupt round-trip starts. A terminal result
   * can beat the acknowledgement — the pinned SDK writes a crashed turn's error
   * result on a direct path that may precede the receipt — so intent, not
   * acknowledgement, is what classifies the outcome.
   */
  interruptRequested: boolean;
  interruptReason: string | undefined;
  /** The single in-flight control request, shared by concurrent callers. */
  interruptAttempt: Promise<void> | undefined;
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
      agentError('provider_unavailable', `the claude query could not be started (${classifyThrown(error)})`),
    );
  }

  let active: ActiveRun | undefined;
  let pumping = false;
  let streamClosed = false;
  let disposing = false;
  let disposed = false;
  let teardown: Promise<void> | undefined;

  /**
   * The run that owns the turn currently on the wire, once a stamped frame has
   * identified it. `undefined` means the turn is not this session's active run:
   * a background or scheduled turn, or a turn whose run has already settled.
   */
  let boundRun: ActiveRun | undefined;
  /**
   * Whether this producer stamps client uuids at all. Older CLIs do not, and
   * demanding a stamp that can never arrive would hang every run, so binding
   * stays permissive until the producer proves it stamps.
   */
  let sawCorrelationStamp = false;
  let announcedUnattributedTurn = false;

  function settle(termination: ProviderRunTermination): void {
    const run = active;
    if (run === undefined || run.terminated) return;
    run.terminated = true;
    active = undefined;
    boundRun = undefined;
    run.settle(termination);
  }

  function noteUnattributedTurn(): void {
    if (announcedUnattributedTurn) return;
    announcedUnattributedTurn = true;
    init.sink.emit({
      payload: {
        type: 'diagnostic',
        level: 'debug',
        message: 'claude emitted a turn that does not belong to the active run; its output is not attributed',
      },
    });
  }

  /**
   * Decide which run, if any, owns this frame.
   *
   * A stamped frame rebinds the turn; unstamped frames follow the binding, as
   * the SDK stamps only a turn's first reply frame and its result.
   */
  function routeTo(message: Parameters<ReturnType<typeof createRunTranslator>['translate']>[0]): ActiveRun | undefined {
    const stamps = correlationStampsOf(message);
    if (stamps.length > 0) {
      sawCorrelationStamp = true;
      const owner = active !== undefined && stamps.includes(active.uuid) ? active : undefined;
      boundRun = owner;
      if (owner === undefined) noteUnattributedTurn();
    }
    return sawCorrelationStamp ? boundRun : active;
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        for await (const message of handle) {
          const run = routeTo(message);
          // A frame belonging to no active run is observed for binding and
          // then dropped: it must not emit into, or complete, another run.
          if (run === undefined) continue;
          const translation = run.translator.translate(message);
          for (const event of translation.events) run.request.sink.emit(event);
          if (translation.termination === undefined) continue;
          settle(
            run.interruptRequested
              ? {
                  outcome: 'interrupted',
                  ...(run.interruptReason === undefined ? {} : { reason: run.interruptReason }),
                }
              : translation.termination,
          );
        }
        streamClosed = true;
        // Disposal owns the outcome of a run still in flight, but the run must
        // still settle: its result can never arrive once the stream is over.
        if (disposing) {
          settle({ outcome: 'interrupted', reason: DISPOSED_REASON });
          return;
        }
        init.sink.emit({
          payload: { type: 'diagnostic', level: 'warning', message: 'claude query stream ended' },
        });
        settle({
          outcome: 'failed',
          error: agentError('provider_contract_violation', 'claude query ended without a result for the active run'),
        });
      } catch (error) {
        streamClosed = true;
        if (disposing) {
          settle({ outcome: 'interrupted', reason: DISPOSED_REASON });
          return;
        }
        const cause = classifyThrown(error);
        init.sink.emit({
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: `the claude query stream failed (${cause})`,
          },
        });
        settle({
          outcome: 'failed',
          error: agentError('provider_unavailable', `the claude query stream failed (${cause})`),
        });
      }
    })();
  }

  /**
   * Client uuids the interrupt receipt says survived the stop.
   *
   * `interrupt_receipt_v1` reports these on a CLI that supports it; an older
   * CLI resolves with `undefined`, which reads here as "nothing reported".
   */
  function survivedInterrupt(receipt: unknown, uuid: string): boolean {
    if (typeof receipt !== 'object' || receipt === null) return false;
    const queued = (receipt as { still_queued?: unknown }).still_queued;
    return Array.isArray(queued) && queued.some((entry) => entry === uuid);
  }

  function beginRun(request: ProviderRunRequest): ProviderRun {
    // Admission closes the moment disposal starts: input is already closed by
    // then, so an admitted run could never produce a result.
    if (disposed || disposing) rejection('session_closed', 'claude provider session is disposed');
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
      uuid: randomUUID(),
      translator: createRunTranslator(),
      request,
      settle: settleCompletion,
      terminated: false,
      interruptRequested: false,
      interruptReason: undefined,
      interruptAttempt: undefined,
    };
    active = run;
    prompts.push(text, run.uuid);
    pump();

    async function deliverInterrupt(): Promise<void> {
      // The whole attempt is what concurrent callers share, so it is cleared
      // only once it has settled — including the survivor branch below.
      try {
        await attemptInterrupt();
      } finally {
        run.interruptAttempt = undefined;
      }
    }

    async function attemptInterrupt(): Promise<void> {
      let receipt: unknown;
      try {
        receipt = await handle.interrupt();
      } catch (error) {
        // Not delivered: drop the intent so the outcome is not mislabelled and
        // an identical retry can still stop the run.
        run.interruptRequested = false;
        run.interruptReason = undefined;
        throw new ProviderRejection(
          agentError('provider_rejected', `claude did not accept the interrupt (${classifyThrown(error)})`),
        );
      }

      if (run.terminated || !survivedInterrupt(receipt, run.uuid)) return;

      // The submitted message outlived the stop and WILL run. The pinned
      // public `interrupt()` takes no arguments, so `cancel_queued` cannot be
      // requested and the survivor cannot be recalled — reporting the run as
      // interrupted would mislabel the turn that is still coming.
      run.interruptRequested = false;
      run.interruptReason = undefined;
      init.sink.emit({
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: 'claude could not recall input that was already submitted; the turn will still run',
        },
      });
      throw new ProviderRejection(
        agentError('provider_rejected', 'claude could not stop this run: its input is still queued', {
          details: { reason: 'input_still_queued' },
        }),
      );
    }

    return {
      completion,
      interrupt(reason?: string): Promise<void> {
        // Terminal, already asked, or already asking: never a second stop.
        if (run.terminated) return Promise.resolve();
        if (run.interruptAttempt !== undefined) return run.interruptAttempt;
        if (run.interruptRequested) return Promise.resolve();
        // Intent is recorded before the round-trip, so a result that arrives
        // first is still classified as an interruption.
        run.interruptRequested = true;
        run.interruptReason = reason === undefined ? undefined : reason.slice(0, MAX_REASON_CHARS);
        const attempt = deliverInterrupt();
        run.interruptAttempt = attempt;
        return attempt;
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

    respondToInteraction(_providerRef: string, _response: InteractionResponse): Promise<void> {
      // The adapter never raises an interaction, so any reference is unknown.
      // Silently accepting one would let a caller believe an approval landed.
      // The reference itself is not echoed: it is caller-controlled text on a
      // durable error.
      return Promise.reject(
        new ProviderRejection(agentError('unknown_interaction', 'the claude adapter does not raise interactions')),
      );
    },

    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      // Fence first: admission must close before anything is awaited, so a run
      // can never be accepted against input that is already closing.
      disposing = true;
      prompts.close();
      abortController.abort();
      // One teardown at a time, shared by concurrent callers.
      if (teardown !== undefined) return teardown;

      const attempt = (async () => {
        try {
          await handle.return?.();
        } catch (error) {
          // Truthful failure: `disposed` stays false so an identical retry can
          // finish the teardown, while admission stays fenced.
          throw new ProviderRejection(
            agentError('provider_rejected', `claude query teardown failed (${classifyThrown(error)})`),
          );
        } finally {
          teardown = undefined;
        }
        disposed = true;
        streamClosed = true;
        settle({ outcome: 'interrupted', reason: DISPOSED_REASON });
      })();
      teardown = attempt;
      return attempt;
    },
  };
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
