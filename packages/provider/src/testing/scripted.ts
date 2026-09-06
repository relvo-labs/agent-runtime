/**
 * A deterministic, in-memory provider for contract tests.
 *
 * This is NOT a production adapter and is not a model of one. It exists so the
 * runtime's contract tests can be exact rather than approximate:
 *
 *   - no timers, no I/O, no randomness;
 *   - a run makes progress only when the caller calls `controller.drain()`, so
 *     a test can observe a genuinely in-flight run and interrupt it;
 *   - the script is data, so a test states the provider behaviour it needs
 *     instead of mocking method-by-method.
 *
 * It is exported from `@relvo-labs/agent-provider/testing` rather than the main
 * entry point so it cannot be pulled into a production bundle by accident.
 */

import {
  type InteractionRequest,
  type InteractionResponse,
  type JsonObject,
  type TurnInput,
  type Usage,
  agentError,
} from '@relvo-labs/agent-protocol';

import { defineProviderDescriptor } from '../descriptor.ts';
import {
  ProviderRejection,
  type AgentProvider,
  type ProviderRecoveryRecord,
  type ProviderRun,
  type ProviderRunTermination,
  type ProviderRunRequest,
  type ProviderSession,
  type ProviderSessionInit,
} from '../spi.ts';

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

export type ScriptStep =
  | { readonly kind: 'delta'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly toolName: string;
      readonly phase: 'invoked' | 'succeeded' | 'failed';
      readonly detail?: JsonObject;
    }
  | { readonly kind: 'usage'; readonly usage: Usage }
  | { readonly kind: 'diagnostic'; readonly level: 'debug' | 'info' | 'warning'; readonly message: string }
  /** Blocks the run until the matching response is delivered. */
  | { readonly kind: 'ask'; readonly ref: string; readonly request: InteractionRequest }
  | { readonly kind: 'succeed' }
  | { readonly kind: 'fail'; readonly message: string };

export type ScriptedProviderOptions = {
  readonly providerId?: string;
  /** Steps used when no per-input script matches. */
  readonly defaultScript?: readonly ScriptStep[];
  /** Exact-match script selection on the concatenated text of a turn's input. */
  readonly scripts?: Readonly<Record<string, readonly ScriptStep[]>>;
  /** Set `unsupported` to exercise the escalate-to-close path. */
  readonly interruptMode?: 'immediate' | 'cooperative' | 'unsupported';
  readonly supportsApproval?: boolean;
  readonly supportsQuestion?: boolean;
  readonly supportsRecovery?: boolean;
};

export type ScriptedController = {
  /**
   * Advance every non-terminal run until it finishes or blocks on an
   * interaction. Deterministic and re-entrant-safe.
   */
  drain(): Promise<void>;
  /** Every run the provider has been asked to start, in order. */
  readonly startedRuns: readonly string[];
  /** Interaction refs still awaiting a response. */
  pendingInteractionRefs(): readonly string[];
  /** Sessions on which `dispose()` has been called. */
  readonly disposedSessions: readonly string[];
  /** Runs on which `interrupt()` has been called, in order. */
  readonly interruptedRuns: readonly string[];
};

function inputText(input: TurnInput): string {
  return input.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

const DEFAULT_SCRIPT: readonly ScriptStep[] = [
  { kind: 'delta', text: 'ack: ' },
  { kind: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  { kind: 'succeed' },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class ScriptedRun implements ProviderRun {
  readonly completion: Promise<ProviderRunTermination>;

  #steps: ScriptStep[];
  #index = 0;
  #terminated = false;
  #interruptRequested = false;
  #blockedOn: string | undefined;
  readonly #settle: Deferred<ProviderRunTermination>;
  readonly #request: ProviderRunRequest;
  readonly #interruptMode: NonNullable<ScriptedProviderOptions['interruptMode']>;
  readonly #onInterrupt: (runRef: string) => void;

  constructor(
    request: ProviderRunRequest,
    steps: readonly ScriptStep[],
    interruptMode: NonNullable<ScriptedProviderOptions['interruptMode']>,
    onInterrupt: (runRef: string) => void,
  ) {
    this.#request = request;
    this.#steps = [...steps];
    this.#interruptMode = interruptMode;
    this.#onInterrupt = onInterrupt;
    this.#settle = deferred<ProviderRunTermination>();
    this.completion = this.#settle.promise;
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  get blockedOn(): string | undefined {
    return this.#blockedOn;
  }

  /** Deliver a response, unblocking the run if it was waiting on this ref. */
  deliver(ref: string): boolean {
    if (this.#blockedOn !== ref) return false;
    this.#blockedOn = undefined;
    return true;
  }

  interrupt(reason?: string): Promise<void> {
    if (this.#terminated) return Promise.resolve(); // idempotent, and safe after the fact
    if (this.#interruptMode === 'unsupported') {
      return Promise.reject(
        new ProviderRejection(
          agentError('capability_unsupported', 'this provider cannot interrupt a run independently of the session'),
        ),
      );
    }
    this.#onInterrupt(this.#request.runRef);
    this.#interruptRequested = true;
    if (this.#interruptMode === 'immediate') this.#finishInterrupted(reason);
    return Promise.resolve();
  }

  /** Session disposal is the fallback for providers without run interrupt. */
  dispose(): void {
    if (!this.#terminated) this.#finishInterrupted('provider session disposed');
  }

  /** Execute steps until the run terminates or blocks. */
  advance(): void {
    if (this.#terminated) return;

    if (this.#interruptRequested) {
      this.#finishInterrupted();
      return;
    }

    while (this.#index < this.#steps.length) {
      if (this.#blockedOn !== undefined) return;

      const step = this.#steps[this.#index];
      if (step === undefined) break;
      this.#index += 1;

      switch (step.kind) {
        case 'delta':
          this.#request.sink.emit({ payload: { type: 'run.message_delta', text: step.text } });
          break;
        case 'tool':
          this.#request.sink.emit({
            payload: {
              type: 'run.tool_activity',
              toolName: step.toolName,
              phase: step.phase,
              ...(step.detail === undefined ? {} : { detail: step.detail }),
            },
          });
          break;
        case 'usage':
          this.#request.sink.emit({ payload: { type: 'run.usage', usage: step.usage } });
          break;
        case 'diagnostic':
          this.#request.sink.emit({
            payload: { type: 'diagnostic', level: step.level, message: step.message },
          });
          break;
        case 'ask':
          this.#blockedOn = step.ref;
          this.#request.sink.emit({
            payload: { type: 'interaction.requested', request: step.request, providerRef: step.ref },
          });
          return;
        case 'succeed':
          this.#finish({ outcome: 'succeeded' });
          return;
        case 'fail':
          this.#finish({
            outcome: 'failed',
            error: agentError('provider_rejected', step.message),
          });
          return;
      }
    }

    // A script that runs out without an explicit terminal step still has to
    // produce exactly one terminal outcome.
    this.#finish({ outcome: 'succeeded' });
  }

  #finishInterrupted(reason?: string): void {
    this.#finish({
      outcome: 'interrupted',
      ...(reason === undefined ? {} : { reason }),
    });
  }

  #finish(termination: ProviderRunTermination): void {
    if (this.#terminated) return; // exactly one terminal outcome, ever
    this.#terminated = true;
    this.#blockedOn = undefined;
    this.#steps = [];
    this.#settle.resolve(termination);
  }
}

type ScriptedCounters = {
  startedRuns: string[];
  interruptedRuns: string[];
  disposedSessions: string[];
};

class ScriptedSession implements ProviderSession {
  readonly runs: ScriptedRun[] = [];
  #disposed = false;

  // Explicit fields: `erasableSyntaxOnly` forbids parameter properties.
  readonly sessionRef: string;
  readonly #options: ScriptedProviderOptions;
  readonly #init: ProviderSessionInit;
  readonly #counters: ScriptedCounters;

  constructor(
    sessionRef: string,
    options: ScriptedProviderOptions,
    init: ProviderSessionInit,
    counters: ScriptedCounters,
  ) {
    this.sessionRef = sessionRef;
    this.#options = options;
    this.#init = init;
    this.#counters = counters;
  }

  startRun(request: ProviderRunRequest): Promise<ScriptedRun> {
    if (this.#disposed) {
      return Promise.reject(new ProviderRejection(agentError('session_closed', 'provider session is disposed')));
    }
    const key = inputText(request.input);
    const steps = this.#options.scripts?.[key] ?? this.#options.defaultScript ?? DEFAULT_SCRIPT;
    const run = new ScriptedRun(request, steps, this.#options.interruptMode ?? 'immediate', (ref) => {
      this.#counters.interruptedRuns.push(ref);
    });
    this.runs.push(run);
    this.#counters.startedRuns.push(request.runRef);
    return Promise.resolve(run);
  }

  respondToInteraction(providerRef: string, _response: InteractionResponse): Promise<void> {
    for (const run of this.runs) {
      if (run.deliver(providerRef)) return Promise.resolve();
    }
    // Re-delivery of an already-applied response is a no-op, not an error.
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve(); // idempotent
    this.#disposed = true;
    for (const run of this.runs) run.dispose();
    this.#counters.disposedSessions.push(this.sessionRef);
    this.#init.sink.emit({
      payload: { type: 'diagnostic', level: 'debug', message: 'scripted provider session disposed' },
    });
    return Promise.resolve();
  }

  exportRecoveryRecord(): Promise<ProviderRecoveryRecord> {
    return Promise.resolve({
      providerId: this.#options.providerId ?? 'scripted',
      providerVersion: '0.1.0',
      wireVersion: '0.4',
      // Deliberately opaque: a consumer must not read inside this.
      opaque: { sessionRef: this.sessionRef, runCount: this.runs.length },
    });
  }
}

export function createScriptedProvider(options: ScriptedProviderOptions = {}): {
  provider: AgentProvider;
  controller: ScriptedController;
} {
  const sessions: ScriptedSession[] = [];
  const state = { startedRuns: [] as string[], interruptedRuns: [] as string[], disposedSessions: [] as string[] };
  let sessionCounter = 0;

  const interruptMode = options.interruptMode ?? 'immediate';
  const descriptor = defineProviderDescriptor({
    providerId: options.providerId ?? 'scripted',
    providerVersion: '0.1.0',
    displayName: 'Scripted test provider',
    run: {
      interrupt:
        interruptMode === 'unsupported'
          ? { mode: 'unsupported' }
          : { mode: interruptMode, deliversPartialOutput: true, sessionRemainsUsable: true },
      streaming: { messageDeltas: true, toolActivity: true, incrementalUsage: true },
      maxConcurrentRunsPerSession: 1,
    },
    interaction: {
      approval: {
        supported: options.supportsApproval ?? true,
        modes: options.supportsApproval === false ? [] : ['once', 'session'],
        blocking: true,
      },
      question: { supported: options.supportsQuestion ?? true, choices: true, multiSelect: true },
      settlementTimeoutMs: null,
    },
    workspace: { requires: 'directory', acceptsOwnership: ['borrowed', 'managed'], writes: false },
    recovery: {
      exportsRecoveryRecord: options.supportsRecovery ?? true,
      resumesFromRecoveryRecord: false,
    },
    extensions: {},
  });

  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession(init: ProviderSessionInit): Promise<ProviderSession> {
      sessionCounter += 1;
      const session = new ScriptedSession(`scripted-session-${String(sessionCounter)}`, options, init, state);
      sessions.push(session);
      return Promise.resolve(session);
    },
  };

  const controller: ScriptedController = {
    async drain(): Promise<void> {
      // Repeat until quiescent: advancing one run can unblock another through
      // the runtime's own event handling.
      for (let pass = 0; pass < 64; pass += 1) {
        let progressed = false;
        for (const session of sessions) {
          for (const run of session.runs) {
            if (run.terminated) continue;
            const before = run.blockedOn;
            run.advance();
            if (before === undefined || run.blockedOn !== before) progressed = true;
          }
        }
        // Let the runtime's own promise handlers observe what just happened.
        await Promise.resolve();
        if (!progressed) return;
      }
      throw new Error('scripted provider failed to reach a quiescent state in 64 passes');
    },
    get startedRuns() {
      return state.startedRuns;
    },
    pendingInteractionRefs(): readonly string[] {
      const refs: string[] = [];
      for (const session of sessions) {
        for (const run of session.runs) {
          if (run.blockedOn !== undefined) refs.push(run.blockedOn);
        }
      }
      return refs;
    },
    get disposedSessions() {
      return state.disposedSessions;
    },
    get interruptedRuns() {
      return state.interruptedRuns;
    },
  };

  return { provider, controller };
}
