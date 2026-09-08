/**
 * The Codex adapter.
 *
 * Shape of the integration, and why:
 *
 *   session   one `codex app-server --stdio` connection, initialized once, plus
 *             one `thread/start` bound to the acquired workspace lease root.
 *             The thread *is* the conversation, so successive runs keep their
 *             context without this adapter persisting or replaying anything.
 *   run       one `turn/start`, and the notifications correlated to the
 *             `(threadId, turnId)` pair it returned, until `turn/completed`.
 *             Exactly one terminal outcome, always.
 *   interrupt `turn/interrupt` — a cooperative request, not a kill. Its `{}`
 *             reply only acknowledges the request; the run is settled by the
 *             `turn/completed` that follows, which the server marks
 *             `interrupted`. The thread survives, so the session does too.
 *   dispose   close stdin, then escalate, then settle. Idempotent and retryable.
 *
 * Native identity — thread ids, turn ids, item ids, request ids, the child
 * process — stays inside this package. Nothing below emits it.
 *
 * Pinned against codex-cli 0.153.4 (`openai/codex@3d2ee51c`), **stable**
 * protocol surface only: `initialize.params.capabilities` is sent as `null`,
 * which by construction cannot opt into `experimentalApi`.
 */

import { isAbsolute } from 'node:path';

import { agentError, type InteractionResponse, type JsonObject, type TurnInput } from '@relvo-labs/agent-protocol';
import {
  ProviderRejection,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderEventSink,
  type ProviderRun,
  type ProviderRunRequest,
  type ProviderRunTermination,
  type ProviderSession,
  type ProviderSessionInit,
} from '@relvo-labs/agent-provider';

import { createCodexClient, type CodexClient, type CodexClientEnd } from './client.ts';
import { CODEX_METHOD, CODEX_NOTIFICATION, asId, asRecord } from './protocol.ts';
import { CodexSessionOptionsSchema, type CodexProviderOptions, type CodexSessionOptions } from './options.ts';
import { CODEX_APP_SERVER_VERSION, createCodexStdioTransport } from './transport.ts';
import {
  classifyThrown,
  correlationOf,
  sameTurn,
  translateAgentMessageDelta,
  translateErrorNotification,
  translateTokenUsage,
  translateTurnCompleted,
  type TurnCorrelation,
} from './translate.ts';
import type { CodexTransport } from './seam.ts';

export const CODEX_PROVIDER_ID = 'codex';
/** This adapter's own version, reported for diagnostics. Not the wire version. */
export const CODEX_ADAPTER_VERSION = '0.1.0';

const PART_SEPARATOR = '\n\n';
const MAX_REASON_CHARS = 300;
const DISPOSED_REASON = 'codex provider session disposed';

/**
 * Frames buffered while `turn/start` is still in flight.
 *
 * The app-server may emit a turn's notifications before its `turn/start`
 * response is read, so early frames are held by thread and replayed once the
 * turn id is known. The bound exists so a producer that never answers cannot
 * grow this without limit.
 */
const MAX_BUFFERED_FRAMES = 512;

/** How many settled turn ids a session remembers, to recognise their late tail. */
const MAX_RETIRED_TURNS = 64;

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): never {
  throw new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

function parseSessionOptions(options: JsonObject): CodexSessionOptions {
  const parsed = CodexSessionOptionsSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  rejection(
    'invalid_request',
    `codex session options are invalid${issue === undefined ? '' : `: ${issue.path.join('.') || '<root>'} ${issue.message}`}`,
  );
}

/**
 * Turn input → one Codex text input item.
 *
 * `text_elements` is omitted: the stable JSON Schema gives it `"default": []`
 * and lists only `text` and `type` as required, so the minimal valid frame is
 * the one that cannot disagree with an evolving element shape.
 */
function promptTextFor(input: TurnInput): string {
  const texts: string[] = [];
  for (const part of input.parts) {
    if (part.type !== 'text') {
      rejection(
        'capability_unsupported',
        `codex adapter accepts \`text\` turn input only; \`${part.type}\` parts are not translated`,
        { capability: 'turnInput.parts', supported: ['text'], requested: part.type },
      );
    }
    texts.push(part.text);
  }
  return texts.join(PART_SEPARATOR);
}

type BufferedFrame = { readonly method: string; readonly params: unknown; readonly correlation: TurnCorrelation };

type ActiveRun = {
  readonly request: ProviderRunRequest;
  /** Assigned from the `turn/start` response before the run is handed back. */
  correlation: TurnCorrelation | undefined;
  settle(termination: ProviderRunTermination): void;
  terminated: boolean;
  /** The turn's own terminal frame has arrived; the run takes no more output. */
  concluded: boolean;
  interruptRequested: boolean;
  interruptReason: string | undefined;
  interruptAttempt: Promise<void> | undefined;
  buffered: BufferedFrame[];
  bufferOverflowed: boolean;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type SessionContext = {
  readonly client: CodexClient;
  readonly threadId: string;
  readonly sink: ProviderEventSink;
};

function createSessionFor(context: SessionContext, wiring: { attach(session: SessionRuntime): void }): ProviderSession {
  const { client, threadId, sink } = context;

  let active: ActiveRun | undefined;
  let streamEnded = false;
  let disposing = false;
  let disposed = false;
  let teardown: Promise<void> | undefined;
  let announcedForeignTurn = false;

  /**
   * Native turn ids this session has already settled.
   *
   * The thread outlives every run on it, so a retired turn's late frames keep
   * arriving on the same connection — the pinned protocol explicitly allows an
   * `item/completed` to land after its `turn/completed` (README,
   * `subAgentActivity`). Recognising them here means they are dropped outright
   * rather than held in the *next* run's pre-binding buffer, where a burst could
   * exhaust the bound and starve the frames that run actually owns. They could
   * never have settled the next run — `bindTurn` discards anything that does not
   * match — but they could have crowded it out, and that is contamination too.
   *
   * Bounded, because a long session runs many turns and this must not grow
   * without limit.
   */
  const retiredTurns = new Set<string>();

  function retire(turnId: string): void {
    retiredTurns.add(turnId);
    while (retiredTurns.size > MAX_RETIRED_TURNS) {
      const oldest = retiredTurns.values().next();
      if (oldest.done === true) break;
      retiredTurns.delete(oldest.value);
    }
  }

  function finalize(run: ActiveRun, termination: ProviderRunTermination): void {
    if (run.terminated) return;
    run.terminated = true;
    run.concluded = true;
    if (run.correlation !== undefined) retire(run.correlation.turnId);
    if (active === run) active = undefined;
    run.settle(termination);
  }

  /**
   * The turn reported its own outcome.
   *
   * The server's `TurnStatus` is authoritative, including after an interrupt:
   * it marks an interrupted turn `interrupted` itself, so local intent is not
   * used to relabel a turn that genuinely finished first. Settlement waits for
   * an in-flight interrupt round-trip only so a *rejected* interrupt can still
   * surface to its caller before the run disappears.
   */
  function conclude(run: ActiveRun, termination: ProviderRunTermination): void {
    if (run.terminated || run.concluded) return;
    run.concluded = true;
    finalize(run, termination);
  }

  function noteForeignTraffic(): void {
    if (announcedForeignTurn) return;
    announcedForeignTurn = true;
    sink.emit({
      payload: {
        type: 'diagnostic',
        level: 'debug',
        message: 'codex emitted turn traffic that does not belong to the active run; it is not attributed',
      },
    });
  }

  /** Apply one correlated frame to the run that owns it. */
  function applyFrame(run: ActiveRun, method: string, params: unknown): void {
    // A run whose terminal frame already arrived takes no further output. The
    // pinned protocol explicitly allows a late `item/completed` after
    // `turn/completed` (README, `subAgentActivity`), so this is the normal
    // case, not a defensive one.
    if (run.concluded || run.terminated) return;

    switch (method) {
      case CODEX_NOTIFICATION.agentMessageDelta:
        for (const event of translateAgentMessageDelta(params)) run.request.sink.emit(event);
        return;
      case CODEX_NOTIFICATION.tokenUsage:
        for (const event of translateTokenUsage(params)) run.request.sink.emit(event);
        return;
      case CODEX_NOTIFICATION.error:
        // Explicitly non-terminal: the run keeps waiting for `turn/completed`.
        for (const event of translateErrorNotification(params)) run.request.sink.emit(event);
        return;
      case CODEX_NOTIFICATION.turnCompleted: {
        const translation = translateTurnCompleted(params);
        if (translation.kind === 'violation') {
          conclude(run, {
            outcome: 'failed',
            error: agentError(
              'provider_contract_violation',
              `codex completed the turn with an unusable status (${translation.reason})`,
              { providerCode: translation.reason },
            ),
          });
          return;
        }
        conclude(run, translation.termination);
        return;
      }
      default:
        // `turn/started`, `item/started`, `item/completed`, and everything the
        // app-server adds later. Read for correlation, not translated: this
        // slice advertises no tool-activity capability, so publishing a
        // half-mapped item would be a false claim.
        return;
    }
  }

  function onNotification(method: string, params: unknown): void {
    const correlation = correlationOf(params);
    if (correlation === undefined) {
      // Thread- and app-scoped notifications carry no turn. Nothing in the
      // bounded surface needs them, and none may settle a run.
      return;
    }
    if (correlation.threadId !== threadId) {
      noteForeignTraffic();
      return;
    }
    // A turn this session already settled. Recognised before anything else so a
    // retired turn's tail can neither be applied nor buffered against the run
    // that came after it.
    if (retiredTurns.has(correlation.turnId)) {
      noteForeignTraffic();
      return;
    }

    const run = active;
    if (run === undefined) {
      noteForeignTraffic();
      return;
    }

    if (run.correlation === undefined) {
      // `turn/start` has not answered yet. Hold the frame by thread and decide
      // ownership once the turn id is known, rather than guessing from arrival
      // order.
      if (run.buffered.length >= MAX_BUFFERED_FRAMES) {
        run.bufferOverflowed = true;
        return;
      }
      run.buffered.push({ method, params, correlation });
      return;
    }

    if (!sameTurn(run.correlation, correlation)) {
      noteForeignTraffic();
      return;
    }
    applyFrame(run, method, params);
  }

  function bindTurn(run: ActiveRun, correlation: TurnCorrelation): void {
    run.correlation = correlation;
    const held = run.buffered.splice(0, run.buffered.length);
    if (run.bufferOverflowed) {
      sink.emit({
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: 'codex produced more early turn traffic than this adapter buffers; some output was dropped',
        },
      });
    }
    for (const frame of held) {
      if (!sameTurn(correlation, frame.correlation)) {
        noteForeignTraffic();
        continue;
      }
      applyFrame(run, frame.method, frame.params);
    }
  }

  /**
   * Settle whatever run is active because the connection, not the turn, ended
   * it. Never infers a successful or interrupted turn from EOF: a stream that
   * stopped is a failure of this run, unless disposal is what stopped it.
   */
  function settleFromStreamEnd(end: CodexClientEnd): void {
    const run = active;
    if (run === undefined || run.terminated) return;
    if (disposing) {
      finalize(run, { outcome: 'interrupted', reason: DISPOSED_REASON });
      return;
    }
    finalize(run, {
      outcome: 'failed',
      error: agentError(
        'provider_unavailable',
        end.end === 'eof'
          ? 'the codex app-server ended before completing this turn'
          : `the codex app-server connection failed before completing this turn (${end.cause ?? 'unknown'})`,
      ),
    });
  }

  const runtime: SessionRuntime = {
    onNotification,
    onServerRequest(method: string): void {
      // Declined by the client layer already; recorded so a host can see that
      // an unimplemented interaction was requested and refused.
      sink.emit({
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: `codex requested an interaction this adapter does not implement (${method}); it was declined`,
        },
      });
    },
    onDrop(reason: string): void {
      sink.emit({
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: `codex sent a frame this adapter could not use (${reason}); it was dropped`,
        },
      });
    },
    onEnd(end: CodexClientEnd): void {
      streamEnded = true;
      if (!disposing) {
        sink.emit({
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message:
              end.end === 'eof'
                ? 'the codex app-server connection ended'
                : `the codex app-server connection failed (${end.cause ?? 'unknown'})`,
          },
        });
      }
      settleFromStreamEnd(end);
    },
  };
  wiring.attach(runtime);

  async function beginRun(request: ProviderRunRequest): Promise<ProviderRun> {
    // Admission closes the moment disposal starts: the connection is already
    // closing by then, so an admitted run could never produce a result.
    if (disposed || disposing) rejection('session_closed', 'codex provider session is disposed');
    if (streamEnded || client.ended) rejection('provider_unavailable', 'the codex app-server connection has ended');
    if (active !== undefined) {
      rejection('illegal_state_transition', 'the codex adapter runs one turn per session at a time');
    }
    const text = promptTextFor(request.input);

    let settleCompletion!: (termination: ProviderRunTermination) => void;
    const completion = new Promise<ProviderRunTermination>((resolve) => {
      settleCompletion = resolve;
    });
    const run: ActiveRun = {
      request,
      correlation: undefined,
      settle: settleCompletion,
      terminated: false,
      concluded: false,
      interruptRequested: false,
      interruptReason: undefined,
      interruptAttempt: undefined,
      buffered: [],
      bufferOverflowed: false,
    };
    // Registered before the request is sent, so notifications that race the
    // `turn/start` response are buffered rather than discarded.
    active = run;

    let result: unknown;
    try {
      result = await client.request(CODEX_METHOD.turnStart, {
        threadId,
        input: [{ type: 'text', text }],
      });
    } catch (error) {
      // Nothing was admitted: drop the registration so the session stays usable
      // and the caller sees why the turn never started.
      if (active === run) active = undefined;
      throw error instanceof ProviderRejection
        ? error
        : new ProviderRejection(
            agentError('provider_unavailable', `codex refused to start the turn (${classifyThrown(error)})`),
          );
    }

    const returnedTurnId = asId(asRecord(asRecord(result)?.turn)?.id);
    if (returnedTurnId === undefined) {
      if (active === run) active = undefined;
      rejection('provider_contract_violation', 'codex accepted the turn without returning a usable turn id');
    }
    const turnId: string = returnedTurnId;
    bindTurn(run, { threadId, turnId });

    async function deliverInterrupt(): Promise<void> {
      try {
        await client.request(CODEX_METHOD.turnInterrupt, { threadId, turnId });
      } catch (error) {
        // Not delivered: drop the intent so an identical retry can still stop
        // the run, and let the caller see the refusal.
        run.interruptRequested = false;
        run.interruptReason = undefined;
        throw error instanceof ProviderRejection
          ? error
          : new ProviderRejection(
              agentError('provider_rejected', `codex did not accept the interrupt (${classifyThrown(error)})`),
            );
      } finally {
        run.interruptAttempt = undefined;
      }
      // The `{}` reply acknowledges the request only. The turn is settled by
      // the `turn/completed` that follows, which the server marks
      // `interrupted`; queued output may still arrive in between and is
      // delivered normally until that frame lands.
    }

    return {
      completion,
      interrupt(reason?: string): Promise<void> {
        if (run.terminated) return Promise.resolve();
        if (run.interruptAttempt !== undefined) return run.interruptAttempt;
        if (run.interruptRequested) return Promise.resolve();
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
        return beginRun(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    respondToInteraction(_providerRef: string, _response: InteractionResponse): Promise<void> {
      // The adapter never raises an interaction — it declines every
      // server-initiated request — so any reference is unknown. Silently
      // accepting one would let a caller believe an approval landed. The
      // reference itself is not echoed: it is caller-controlled text on a
      // durable error.
      return Promise.reject(
        new ProviderRejection(agentError('unknown_interaction', 'the codex adapter does not raise interactions')),
      );
    },

    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      // Fence first: admission must close before anything is awaited, so a run
      // can never be accepted against a connection that is already closing.
      disposing = true;
      if (teardown !== undefined) return teardown;

      const attempt = (async () => {
        // Yield before touching the connection. A `close()` that throws
        // *synchronously* rather than returning a rejected promise would
        // otherwise run the `finally` below — which clears the shared attempt —
        // before this scope has even assigned it, caching an already-rejected
        // promise as the permanent answer to every later disposal.
        await Promise.resolve();
        try {
          await client.close();
        } catch (error) {
          // Truthful failure: `disposed` stays false so an identical retry can
          // finish the teardown, while admission stays fenced.
          throw new ProviderRejection(
            agentError('provider_rejected', `codex app-server teardown failed (${classifyThrown(error)})`),
          );
        } finally {
          teardown = undefined;
        }
        disposed = true;
        streamEnded = true;
        const run = active;
        if (run !== undefined && !run.terminated) {
          finalize(run, { outcome: 'interrupted', reason: DISPOSED_REASON });
        }
      })();
      teardown = attempt;
      return attempt;
    },
  };
}

/** Callbacks the client layer drives, wired after the session object exists. */
type SessionRuntime = {
  onNotification(method: string, params: unknown): void;
  onServerRequest(method: string): void;
  onDrop(reason: string): void;
  onEnd(end: CodexClientEnd): void;
};

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

type OpenedConnection = {
  readonly client: CodexClient;
  readonly threadId: string;
  readonly wiring: SessionRuntimeBox;
};

async function openConnection(
  transport: CodexTransport,
  options: CodexProviderOptions,
  overrides: CodexSessionOptions,
  root: string,
): Promise<OpenedConnection> {
  const box: SessionRuntimeBox = { runtime: undefined };

  const client = createCodexClient(
    transport,
    {
      onNotification(method: string, params: unknown): void {
        const runtime = box.runtime;
        if (runtime === undefined) {
          // Frames that arrive during the handshake belong to no run yet.
          // Nothing in the bounded surface needs them.
          return;
        }
        runtime.onNotification(method, params);
      },
      onServerRequest(method: string): void {
        box.runtime?.onServerRequest(method);
      },
      onDrop(reason: string): void {
        box.runtime?.onDrop(reason);
      },
      onEnd(end: CodexClientEnd): void {
        const runtime = box.runtime;
        if (runtime === undefined) {
          box.endedDuringHandshake = end;
          return;
        }
        runtime.onEnd(end);
      },
    },
    options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
  );

  // One `initialize` per connection, then the parameterless `initialized`
  // notification, before any other method. `capabilities: null` is the stable
  // shape that cannot opt into `experimentalApi` or `requestAttestation` —
  // and because attestation is not requested, `attestation/generate` is never
  // sent to this client.
  await client.request(CODEX_METHOD.initialize, {
    clientInfo: {
      name: options.clientName ?? 'relvo_agent_runtime',
      title: 'Relvo Agent Runtime',
      version: options.clientVersion ?? CODEX_ADAPTER_VERSION,
    },
    capabilities: null,
  });
  client.notify(CODEX_METHOD.initialized);

  const sandbox = overrides.sandboxMode ?? options.sandboxMode ?? 'read-only';
  const model = overrides.model ?? options.model;
  const started = await client.request(CODEX_METHOD.threadStart, {
    cwd: root,
    // No approval or question is bridged, so none may be requested: anything
    // that would ask a human must fail closed rather than hang a run nobody
    // can answer.
    approvalPolicy: 'never',
    sandbox,
    // In-memory only. Nothing about this conversation is materialised on disk
    // by the adapter, and `thread.path` is null.
    ephemeral: true,
    ...(model === undefined ? {} : { model }),
  });

  const threadId = asId(asRecord(asRecord(started)?.thread)?.id);
  if (threadId === undefined) {
    throw new ProviderRejection(
      agentError('provider_contract_violation', 'codex started a thread without returning a usable thread id'),
    );
  }
  return { client, threadId, wiring: box };
}

/**
 * Late-bound wiring between the client layer and the session.
 *
 * The client must exist before the handshake can run, but the session cannot
 * exist before the handshake produces a thread id. This box carries the
 * callbacks across that gap, and remembers a connection that died inside it.
 */
type SessionRuntimeBox = {
  runtime: SessionRuntime | undefined;
  endedDuringHandshake?: CodexClientEnd;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Create the Codex provider adapter.
 *
 * Register it with a runtime by id; the runtime never imports this package.
 * Omit `options.transport` to spawn `codex app-server --stdio`, or pass one to
 * run against a host-managed connection or a deterministic double.
 */
export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const descriptor = defineProviderDescriptor({
    providerId: CODEX_PROVIDER_ID,
    providerVersion: CODEX_ADAPTER_VERSION,
    displayName: 'Codex app-server',
    run: {
      // `turn/interrupt` is a request: its `{}` reply acknowledges only, and the
      // turn ends later with `status: "interrupted"`. Output queued before the
      // stop still arrives, and the thread survives, so the session does too.
      interrupt: { mode: 'cooperative', deliversPartialOutput: true, sessionRemainsUsable: true },
      streaming: {
        messageDeltas: true,
        // Command, file-change and MCP items are stable in the protocol, but
        // their payloads carry commands, cwd and executor-native paths that
        // need a redaction contract this slice does not build. Claiming the
        // capability without mapping it would be a false promise.
        toolActivity: false,
        // `thread/tokenUsage/updated` streams during the turn, correlated by
        // `(threadId, turnId)`.
        incrementalUsage: true,
      },
      maxConcurrentRunsPerSession: 1,
    },
    // Every server-initiated request is declined, so no interaction is claimed.
    interaction: { approval: {}, question: {}, settlementTimeoutMs: null },
    workspace: {
      requires: 'directory',
      acceptsOwnership: ['borrowed', 'managed'],
      // Always `true`, including under `sandboxMode: 'read-only'`.
      //
      // The read-only policy constrains Codex's *own* filesystem tool calls. It
      // is not an isolation boundary for the MCP servers, hooks and plugins the
      // user's Codex configuration may start: those run with their own
      // authority, and nothing in this adapter or this runtime bounds them.
      // Deriving `writes: false` from the sandbox mode would tell a host the
      // workspace is safe from mutation when it is not, so this stays `true`
      // and a host treats the lease root as mutable regardless of policy.
      writes: true,
    },
    recovery: {},
    extensions: {
      appServerVersion: CODEX_APP_SERVER_VERSION,
      protocolSurface: 'stable',
      transport: 'stdio-jsonl',
      /** Deltas arrive per streamed text fragment, not per whole message. */
      textGranularity: 'delta',
      supportedInputParts: ['text'],
      /**
       * The execution policy this adapter will request from the app-server.
       * Provider-declared intent for UX (ADR-0009) — reported so a host can see
       * what was configured, not as an enforcement claim.
       */
      declaredSandboxMode: options.sandboxMode ?? 'read-only',
      /**
       * Stated explicitly so no consumer infers it from the sandbox mode: a
       * read-only policy does not isolate MCP servers, hooks or plugins started
       * from the user's Codex configuration, and this slice makes no
       * side-effect-free claim of any kind.
       */
      isolatesConfiguredTooling: false,
    },
  });

  return {
    describe: () => descriptor,
    async createSession(init: ProviderSessionInit): Promise<ProviderSession> {
      const overrides = parseSessionOptions(init.options);
      if (init.workspace.root === '' || !isAbsolute(init.workspace.root)) {
        rejection('invalid_request', 'the codex adapter requires an absolute workspace root');
      }

      const transport = await Promise.resolve(
        options.transport === undefined
          ? createCodexStdioTransport(
              { cwd: init.workspace.root },
              {
                ...(options.executable === undefined ? {} : { executable: options.executable }),
                ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
              },
            )
          : options.transport({ cwd: init.workspace.root }),
      );

      let opened: Awaited<ReturnType<typeof openConnection>>;
      try {
        opened = await openConnection(transport, options, overrides, init.workspace.root);
      } catch (error) {
        // A handshake that never completed owns nothing: tear the connection
        // down rather than leaking a child process behind a rejected session.
        await transport.close().catch(() => undefined);
        throw error instanceof ProviderRejection
          ? error
          : new ProviderRejection(
              agentError(
                'provider_unavailable',
                `the codex app-server could not be initialized (${classifyThrown(error)})`,
              ),
            );
      }

      const session = createSessionFor(
        { client: opened.client, threadId: opened.threadId, sink: init.sink },
        {
          attach(runtime: SessionRuntime): void {
            opened.wiring.runtime = runtime;
            const ended = opened.wiring.endedDuringHandshake;
            // The connection died between the handshake completing and the
            // session being wired. Report it now rather than losing it.
            if (ended !== undefined) runtime.onEnd(ended);
          },
        },
      );
      return session;
    },
  };
}
