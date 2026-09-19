/**
 * The approval bridge: one pinned native request shape, one neutral approval.
 *
 * The app-server asks the client to decide things. This module decides which of
 * those questions can be asked of a host **without losing anything**, turns
 * exactly those into the neutral `interaction.requested` the protocol already
 * defines, and declines the rest on their own native request id.
 *
 * ## The mapping table, pinned to codex-cli 0.153.4 (stable surface only)
 *
 * | `ServerRequest` method                   | Bridged | Why                                                                                                                          |
 * | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
 * | `item/commandExecution/requestApproval`  | **yes** | Carries its own reviewable subject (`command`, `cwd`, `reason`), and `accept`/`acceptForSession`/`decline` map onto `once`/`session`/denied. |
 * | `item/fileChange/requestApproval`        | no      | `FileChangeRequestApprovalParams` names no files. The change set lives in the `itemId` item, which this adapter does not surface (`streaming.toolActivity: false`), so the approval would have no reviewable subject. |
 * | `item/tool/requestUserInput`             | no      | Every `ToolRequestUserInput*` type is annotated EXPERIMENTAL and is gated behind `InitializeCapabilities.experimentalApi`, which this adapter never opts into (`capabilities: null`). Its payload is also a question *list* with `isSecret` / `isOther` / `autoResolutionMs` facts the single neutral `QuestionRequest` cannot carry. |
 * | `item/permissions/requestApproval`       | no      | `PermissionsRequestApprovalResponse` requires a `GrantedPermissionProfile` and a `PermissionGrantScope`, and has no decline variant at all. A neutral approval response carries a decision and a mode. |
 * | `mcpServer/elicitation/request`          | no      | An arbitrary multi-field form (`McpElicitationSchema`), with a *nullable* `turnId` — so neither the one-question mapping nor run correlation holds. |
 * | `item/tool/call`                         | no      | Asks the client to execute a tool. Not an interaction.                                                                        |
 * | `account/chatgptAuthTokens/refresh`      | no      | A credential operation. This adapter holds no credentials.                                                                    |
 * | `attestation/generate`                   | no      | Requires `InitializeCapabilities.requestAttestation`, which is never sent.                                                    |
 * | `applyPatchApproval` (legacy)            | no      | Carries `conversationId` / `callId` and **no `turnId`**, so it cannot be bound to the active run.                              |
 * | `execCommandApproval` (legacy)           | no      | Same: no `turnId`, so it cannot be correlated.                                                                                |
 *
 * ## What this module guarantees
 *
 *  1. **No silent drop and no automatic approval.** Every request is answered
 *     exactly once — by a host decision, by an explicit typed decline, or by a
 *     `decline` at teardown. Nothing is granted that a host did not grant.
 *  2. **Lossless or refused.** A command approval is bridged only when its
 *     whole decision survives the round trip. A request that proposes an
 *     execpolicy or network-policy amendment is refused rather than answered
 *     with a plain `accept`, because the neutral response cannot carry the
 *     amendment the server is actually asking about.
 *  3. **Nothing native escapes.** The reference handed out is this adapter's
 *     own nonce-namespaced counter, never the native `RequestId`, `itemId`,
 *     `threadId` or `turnId`. The native reply closure is held here and never
 *     published.
 *  4. **Exactly once, in process.** A reference settles one callback one time.
 *     Identical redelivery is a no-op; a different answer is refused. This is
 *     process-local settlement, not crash-safe exactly-once.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  agentError,
  InteractionResponseSchema,
  type InteractionResponse,
  type JsonObject,
  type JsonValue,
  type QuestionItem,
} from '@relvo-labs/agent-protocol';
import { ProviderRejection, type ProviderEventSink } from '@relvo-labs/agent-provider';

import { INVALID_PARAMS, INVALID_REQUEST } from './protocol.ts';
import { sameTurn, type TurnCorrelation } from './translate.ts';

/** The one server-initiated method this adapter answers with a host decision. */
export const CODEX_BRIDGED_APPROVAL = 'item/commandExecution/requestApproval';

/** The one server-initiated method this adapter answers with host answers. */
export const CODEX_BRIDGED_QUESTION = 'item/tool/requestUserInput';

/**
 * Approval modes this adapter can actually encode.
 *
 * `once` is `accept` and `session` is `acceptForSession`. There is no
 * `persistent`: the only decision variant with that reach is
 * `acceptWithExecpolicyAmendment`, which requires an amendment payload the
 * neutral response has nowhere to carry.
 */
export const CODEX_APPROVAL_MODES = ['once', 'session'] as const;

/**
 * Largest approval detail this adapter will publish, as canonical JSON.
 *
 * The detail is the reviewable subject, so it is never truncated — a human
 * cannot authorize what they were shown half of. A request whose detail does
 * not fit is refused instead.
 */
export const MAX_APPROVAL_DETAIL_CHARS = 16_000;

/** `ApprovalSubject.summary` is bounded by the protocol at 2000 characters. */
const MAX_SUMMARY_CHARS = 2000;

/**
 * Approvals one session will track at once, pending and settled together.
 *
 * Settled entries are retained so an identical redelivery stays a no-op, and
 * every entry is dropped when its run ends, so this bounds one run's traffic.
 * A server that floods past it is answered explicitly rather than allowed to
 * grow this map without limit.
 */
export const MAX_TRACKED_APPROVALS = 256;

/** Marks an entry retired without an answer; never equal to an applied key. */
const RETIRED = 'retired';

/** Sent to the server when a run ends with an approval still outstanding. */
const TEARDOWN_DECISION = 'decline';

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Why a recognised approval request could not be bridged.
 *
 * Bounded tokens, never upstream prose: these reach a durable diagnostic, and
 * the request payload is another process's text.
 */
export type ApprovalRefusal =
  | 'malformed'
  | 'kind_unsupported'
  | 'environment_unsupported'
  | 'no_reviewable_command'
  | 'policy_amendment_proposed'
  | 'detail_too_large';

export type ApprovalTranslation =
  | {
      readonly kind: 'request';
      readonly correlation: TurnCorrelation;
      readonly subject: { readonly category: 'command'; readonly summary: string; readonly detail: JsonObject };
    }
  | { readonly kind: 'refused'; readonly reason: ApprovalRefusal };

function refused(reason: ApprovalRefusal): ApprovalTranslation {
  return { kind: 'refused', reason };
}

/**
 * Private native schema derived from the 0.153.4 stable generated
 * CommandExecutionRequestApprovalParams.json and its CommandAction definitions.
 * JSON Schema defaults make kind/environment optional (unlike generated TS).
 * Close every object deliberately: unknown context must not silently disappear.
 * Parsing reconstructs actions from declared fields; no raw native object is
 * forwarded to a neutral event. The safe integer bound avoids rounded int64s.
 */
const CommandActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read'), command: z.string(), name: z.string(), path: z.string() }),
  z.strictObject({ type: z.literal('listFiles'), command: z.string(), path: z.string().nullish() }),
  z.strictObject({
    type: z.literal('search'),
    command: z.string(),
    query: z.string().nullish(),
    path: z.string().nullish(),
  }),
  z.strictObject({ type: z.literal('unknown'), command: z.string() }),
]);
const CommandApprovalParamsSchema = z.strictObject({
  kind: z.enum(['command', 'writeStdin']).default('command'),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string(),
  startedAtMs: z.int(),
  approvalId: z.string().nullish(),
  environmentId: z.string().nullish(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
  commandActions: z.array(CommandActionSchema).nullish(),
  proposedExecpolicyAmendment: z.array(z.string()).nullish(),
  proposedNetworkPolicyAmendments: z
    .array(
      z.strictObject({
        action: z.enum(['allow', 'deny']),
        host: z.string(),
      }),
    )
    .nullish(),
  networkApprovalContext: z
    .strictObject({
      host: z.string(),
      protocol: z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp']),
    })
    .nullish(),
});

/** Reconstruct JSON-only display fields, omitting absent optional properties. */
function commandActionDetail(action: z.infer<typeof CommandActionSchema>): JsonObject {
  const base = { type: action.type, command: action.command };
  switch (action.type) {
    case 'read':
      return { ...base, name: action.name, path: action.path };
    case 'listFiles':
      return { ...base, ...(action.path === undefined ? {} : { path: action.path }) };
    case 'search':
      return {
        ...base,
        ...(action.path === undefined ? {} : { path: action.path }),
        ...(action.query === undefined ? {} : { query: action.query }),
      };
    case 'unknown':
      return base;
  }
}

/** Validate the complete native request before admitting any routing state. */
export function translateCommandApproval(params: unknown): ApprovalTranslation {
  const parsed = CommandApprovalParamsSchema.safeParse(params);
  if (!parsed.success) return refused('malformed');
  const record = parsed.data;
  const { threadId, turnId } = record;
  if (record.kind !== 'command') return refused('kind_unsupported');
  if (record.environmentId != null) return refused('environment_unsupported');

  // These contexts require a response the neutral approval cannot carry.
  if (
    record.proposedExecpolicyAmendment != null ||
    (record.proposedNetworkPolicyAmendments?.length ?? 0) > 0 ||
    record.networkApprovalContext != null
  ) {
    return refused('policy_amendment_proposed');
  }

  const { command, cwd, reason, commandActions } = record;
  if (command == null || command === '') return refused('no_reviewable_command');
  const detail: JsonObject = {
    command,
    ...(cwd == null ? {} : { cwd }),
    ...(reason == null ? {} : { reason }),
    ...(commandActions == null ? {} : { commandActions: commandActions.map(commandActionDetail) }),
  };
  // Nothing here is truncated. Either the whole subject is publishable, or the
  // request is refused and the server is told so.
  if (JSON.stringify(detail).length > MAX_APPROVAL_DETAIL_CHARS) return refused('detail_too_large');

  const inline = `codex requests approval to run \`${command}\``;
  const summary =
    inline.length <= MAX_SUMMARY_CHARS
      ? inline
      : `codex requests approval to run a command of ${String(command.length)} characters; the exact command is in this approval's detail`;

  return { kind: 'request', correlation: { threadId, turnId }, subject: { category: 'command', summary, detail } };
}

// ---------------------------------------------------------------------------
// Question translation
// ---------------------------------------------------------------------------

/**
 * Why a recognised `item/tool/requestUserInput` could not be bridged.
 *
 * Bounded tokens, never upstream prose.
 */
export type QuestionRefusal =
  | 'malformed'
  | 'not_blocking'
  | 'auto_resolution_requested'
  | 'question_count'
  | 'duplicate_question_id'
  | 'duplicate_option_label'
  | 'detail_too_large';

/**
 * Private native schema derived from the 0.153.4 generated
 * `ToolRequestUserInputParams.json`. The JSON Schema gives `isOther`,
 * `isSecret` and `autoResolutionMs` defaults, so they are optional on the wire
 * even though the generated TypeScript declares them required. Closed
 * deliberately: an unknown member is a fact this adapter has not been taught to
 * carry, and carrying on would drop it.
 */
const ToolRequestUserInputOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string(),
});

const ToolRequestUserInputQuestionSchema = z.strictObject({
  id: z.string().min(1),
  header: z.string(),
  question: z.string().min(1),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  options: z.array(ToolRequestUserInputOptionSchema).nullish(),
});

const ToolRequestUserInputParamsSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(ToolRequestUserInputQuestionSchema),
  isBlocking: z.boolean(),
  autoResolutionMs: z.int().nonnegative().nullish(),
});

/**
 * Largest neutral batch the protocol carries. A native request above it is
 * refused rather than truncated.
 */
const MAX_QUESTIONS = 32;

/** Bound on the published question payload, as canonical JSON. */
export const MAX_QUESTION_DETAIL_CHARS = 16_000;

/**
 * The adapter-private mapping from neutral keys back to the native identifiers
 * the answer map must be built from. It never leaves this module.
 */
export type QuestionPlanEntry = {
  readonly key: string;
  /** Native question id. Adapter-private; the answer map is keyed by it. */
  readonly questionId: string;
  /** Neutral choice value → native option label. Empty for a free-text question. */
  readonly labels: ReadonlyMap<string, string>;
};

export type QuestionTranslation =
  | {
      readonly kind: 'request';
      readonly correlation: TurnCorrelation;
      readonly questions: readonly QuestionItem[];
      readonly plan: readonly QuestionPlanEntry[];
    }
  | { readonly kind: 'refused'; readonly reason: QuestionRefusal };

function refusedQuestion(reason: QuestionRefusal): QuestionTranslation {
  return { kind: 'refused', reason };
}

/** Validate the complete native request before admitting any routing state. */
export function translateUserInputRequest(params: unknown): QuestionTranslation {
  const parsed = ToolRequestUserInputParamsSchema.safeParse(params);
  if (!parsed.success) return refusedQuestion('malformed');
  const record = parsed.data;

  // A non-blocking request is one the turn does not wait for. Raising it would
  // ask a host to answer something the server may already have moved past, and
  // this adapter promises that a settled answer reaches the native wait point.
  if (!record.isBlocking) return refusedQuestion('not_blocking');

  // `autoResolutionMs` asks the client to answer *for* the user after an
  // interval. This adapter never fabricates an answer and imposes no
  // settlement deadline, so a request that wants one is refused rather than
  // silently answered late or never.
  if (record.autoResolutionMs != null) return refusedQuestion('auto_resolution_requested');

  if (record.questions.length === 0 || record.questions.length > MAX_QUESTIONS) {
    return refusedQuestion('question_count');
  }

  const seenIds = new Set<string>();
  const questions: QuestionItem[] = [];
  const plan: QuestionPlanEntry[] = [];

  for (const [index, question] of record.questions.entries()) {
    // The native answer map is keyed by question id, so two questions sharing
    // one id cannot both be answered.
    if (seenIds.has(question.id)) return refusedQuestion('duplicate_question_id');
    seenIds.add(question.id);

    const labels = new Map<string, string>();
    const choices: { value: string; label: string; description?: string }[] = [];
    const seenLabels = new Set<string>();
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      // The native answer is the option label, so duplicates are ambiguous.
      if (seenLabels.has(option.label)) return refusedQuestion('duplicate_option_label');
      seenLabels.add(option.label);
      const value = `o${String(optionIndex + 1)}`;
      labels.set(value, option.label);
      choices.push({
        value,
        label: option.label,
        ...(option.description === '' ? {} : { description: option.description }),
      });
    }

    // The adapter's own ordinal. The native `id` is provider identity and must
    // not become a token a caller can address the app-server's internals with.
    const key = `q${String(index + 1)}`;
    questions.push({
      key,
      prompt: question.question,
      ...(question.header === '' ? {} : { header: question.header }),
      ...(choices.length === 0 ? {} : { choices }),
      // `ToolRequestUserInputQuestion` has no multi-select field in 0.153.4.
      // The answer is an array, so several answers are *representable*, but
      // nothing in the request says several are *permitted* — so none is
      // offered rather than guessed at.
      multiSelect: false,
      // With no options at all the only possible answer is text. With options,
      // `isOther` is exactly the native "let them type something else" flag.
      allowFreeText: choices.length === 0 || question.isOther,
      sensitive: question.isSecret,
    });
    plan.push({ key, questionId: question.id, labels });
  }

  // Nothing here is truncated: either the whole batch is publishable, or the
  // request is refused and the server is told so.
  if (JSON.stringify(questions).length > MAX_QUESTION_DETAIL_CHARS) return refusedQuestion('detail_too_large');

  return {
    kind: 'request',
    correlation: { threadId: record.threadId, turnId: record.turnId },
    questions,
    plan,
  };
}

/**
 * Build the native answer map from one validated neutral response.
 *
 * The runtime has already proven the response answers every question exactly
 * once, so this cannot produce a partial map — and it throws rather than
 * omitting a key if that guarantee is ever violated by a direct SPI caller.
 */
export function nativeUserInputAnswers(
  plan: readonly QuestionPlanEntry[],
  response: Extract<InteractionResponse, { kind: 'question_set' }>,
): JsonObject {
  const answers: Record<string, JsonValue> = {};
  for (const entry of plan) {
    const answer = response.answers[entry.key];
    if (answer === undefined) {
      throw rejection('invalid_request', 'every question in this codex batch must be answered');
    }
    if (answer.type === 'text') {
      answers[entry.questionId] = { answers: [answer.text] };
      continue;
    }
    const labels = answer.values.map((value) => entry.labels.get(value));
    if (labels.some((label) => label === undefined)) {
      throw rejection('invalid_request', 'a selection named a choice this codex question does not offer');
    }
    answers[entry.questionId] = { answers: labels as string[] };
  }
  return { answers };
}

/** Neutral response → the pinned `CommandExecutionApprovalDecision`. */
function nativeDecision(response: Extract<InteractionResponse, { kind: 'approval' }>): string {
  if (response.decision !== 'approved') {
    // `decline` denies without ending the turn. `cancel` would also interrupt
    // it, which is a second effect nobody asked for.
    return 'decline';
  }
  return response.mode === 'session' ? 'acceptForSession' : 'accept';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * One server-initiated request, with its reply held behind closures.
 *
 * The native `RequestId` is deliberately absent: the client layer owns it and
 * hands out only the ability to answer it once.
 */
export type CodexServerRequestOffer = {
  readonly method: string;
  readonly params: unknown;
  /** Answer with a result. Returns false if it was already answered. */
  respond(result: JsonValue): boolean;
  /** Answer with a JSON-RPC error. Returns false if it was already answered. */
  reject(code: number, message: string): boolean;
};

/** The run an approval may belong to right now. */
export type ApprovalOwner = {
  /** Run identity. Compared, never inspected, never published. */
  readonly key: object;
  /** The turn this run is bound to. An approval must name exactly this pair. */
  readonly correlation: TurnCorrelation;
  /** The run's own sink. An interaction belongs to the run that raised it. */
  readonly sink: ProviderEventSink;
};

/** Whether the registry took responsibility for answering a request. */
export type OfferVerdict = 'taken' | 'unhandled';

export type CodexInteractionRegistry = {
  /**
   * Consider one server-initiated request.
   *
   * `taken` means this registry has answered it or will answer it later, so the
   * caller must not reply. `unhandled` means the method is not bridged at all
   * and the caller should decline it.
   */
  offer(request: CodexServerRequestOffer, owner: ApprovalOwner | undefined): OfferVerdict;
  /** Apply one settled neutral response. Throws `ProviderRejection` if it cannot. */
  settle(providerRef: string, response: InteractionResponse): void;
  /** Decline and forget everything one run raised. Safe to call repeatedly. */
  retire(key: object): void;
  /** Decline and forget everything, for session teardown. */
  retireAll(): void;
  /** Approvals currently tracked. Pending and settled. */
  readonly trackedCount: number;
};

type Entry = {
  readonly ownerKey: object;
  readonly respond: (result: JsonValue) => boolean;
  /**
   * The answer already applied, canonicalized. Present means the one native
   * callback has been used: identical redelivery is a no-op, a different answer
   * is a conflict, and neither reaches the server twice.
   */
  applied: string | undefined;
} & (
  | { readonly kind: 'approval'; readonly plan?: undefined }
  | { readonly kind: 'question'; readonly plan: readonly QuestionPlanEntry[] }
);

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): ProviderRejection {
  return new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

/** Canonical form of an applied answer, to tell redelivery from conflict. */
function appliedKey(response: Extract<InteractionResponse, { kind: 'approval' }>): string {
  return JSON.stringify([response.decision, response.mode ?? null, response.reason ?? null]);
}

/**
 * The same, for a batch. Key order is not semantic, so it is normalized: the
 * same answers collected in a different order are the same answer.
 */
function appliedQuestionKey(response: Extract<InteractionResponse, { kind: 'question_set' }>): string {
  return JSON.stringify(
    Object.keys(response.answers)
      .sort()
      .map((key) => [key, response.answers[key]]),
  );
}

export type InteractionRegistryOptions = {
  /**
   * Whether `item/tool/requestUserInput` is bridged. When false the method is
   * reported `unhandled`, so the caller declines it with `-32601` exactly as
   * before — an unbridged blocking request must still be answered, never
   * ignored.
   */
  readonly questions: boolean;
};

export function createInteractionRegistry(
  sessionSink: ProviderEventSink,
  options: InteractionRegistryOptions = { questions: false },
): CodexInteractionRegistry {
  const bridgesQuestions = options.questions;
  const entries = new Map<string, Entry>();
  /**
   * This registry's own reference namespace.
   *
   * A bare counter would name every session's first approval identically, so a
   * caller driving the SPI directly could settle another session's approval by
   * guessing `approval-1`. The nonce is adapter-generated and says nothing
   * about the connection, the workspace or the host.
   */
  const namespace = randomUUID();
  let issued = 0;

  function note(sink: ProviderEventSink, level: 'warning' | 'debug', message: string): void {
    sink.emit({ payload: { type: 'diagnostic', level, message } });
  }

  /** Decline one entry that was never answered, then forget it. */
  function retireEntry(providerRef: string, entry: Entry): void {
    entries.delete(providerRef);
    if (entry.applied !== undefined) return;
    entry.applied = RETIRED;
    // Best effort: once the stream has ended nothing can be written, but the
    // entry still goes, so a late response cannot settle anything.
    //
    // A question has no "decline" variant — `ToolRequestUserInputResponse` is
    // an answer map and nothing else — so an unanswered batch is retired with
    // an *empty* map. That answers no question, invents nothing, and releases
    // the server's wait, which is the only honest thing left to send.
    entry.respond(entry.kind === 'question' ? { answers: {} } : { decision: TEARDOWN_DECISION });
  }

  function clear(key: object | undefined): void {
    for (const [providerRef, entry] of [...entries]) {
      if (key !== undefined && entry.ownerKey !== key) continue;
      retireEntry(providerRef, entry);
    }
  }

  /**
   * Consider one `item/tool/requestUserInput`.
   *
   * Mirrors the approval path exactly: validate the whole native request,
   * refuse it on its own request id if anything cannot be carried, admit it
   * only against the active turn, and only then raise one neutral batch.
   */
  function offerQuestion(request: CodexServerRequestOffer, owner: ApprovalOwner | undefined): OfferVerdict {
    const sink = owner?.sink ?? sessionSink;
    const translation = translateUserInputRequest(request.params);
    if (translation.kind === 'refused') {
      request.reject(INVALID_PARAMS, 'this user-input request cannot be represented faithfully');
      note(
        sink,
        'warning',
        `codex requested user input this adapter cannot map (${translation.reason}); it was declined`,
      );
      return 'taken';
    }

    if (owner === undefined || !sameTurn(owner.correlation, translation.correlation)) {
      request.reject(INVALID_REQUEST, 'no active turn owns this user-input request');
      note(sink, 'warning', 'codex requested user input that does not belong to the active turn; it was declined');
      return 'taken';
    }

    if (entries.size >= MAX_TRACKED_APPROVALS) {
      request.reject(INVALID_REQUEST, 'too many interactions are outstanding on this session');
      note(sink, 'warning', 'codex requested more interactions than this adapter tracks at once; it was declined');
      return 'taken';
    }

    issued += 1;
    const providerRef = `question-${namespace}-${String(issued)}`;
    entries.set(providerRef, {
      kind: 'question',
      ownerKey: owner.key,
      plan: translation.plan,
      respond: (result: JsonValue) => request.respond(result),
      applied: undefined,
    });
    sink.emit({
      payload: {
        type: 'interaction.requested',
        providerRef,
        request: { kind: 'question_set', questions: [...translation.questions] },
      },
    });
    return 'taken';
  }

  return {
    offer(request: CodexServerRequestOffer, owner: ApprovalOwner | undefined): OfferVerdict {
      if (request.method === CODEX_BRIDGED_QUESTION) {
        if (!bridgesQuestions) return 'unhandled';
        return offerQuestion(request, owner);
      }
      if (request.method !== CODEX_BRIDGED_APPROVAL) return 'unhandled';

      const sink = owner?.sink ?? sessionSink;
      const translation = translateCommandApproval(request.params);
      if (translation.kind === 'refused') {
        request.reject(INVALID_PARAMS, 'this approval request cannot be represented faithfully');
        note(
          sink,
          'warning',
          `codex requested a command approval this adapter cannot map (${translation.reason}); it was declined`,
        );
        return 'taken';
      }

      // Correlation decides admission, and only an active, bound, uninterrupted
      // run can own an approval. Everything else is refused without raising
      // anything: a request nobody owns must never create routing state.
      if (owner === undefined || !sameTurn(owner.correlation, translation.correlation)) {
        request.reject(INVALID_REQUEST, 'no active turn owns this approval request');
        note(sink, 'warning', 'codex requested an approval that does not belong to the active turn; it was declined');
        return 'taken';
      }

      if (entries.size >= MAX_TRACKED_APPROVALS) {
        request.reject(INVALID_REQUEST, 'too many approvals are outstanding on this session');
        note(sink, 'warning', 'codex requested more approvals than this adapter tracks at once; it was declined');
        return 'taken';
      }

      issued += 1;
      const providerRef = `approval-${namespace}-${String(issued)}`;
      entries.set(providerRef, {
        kind: 'approval',
        ownerKey: owner.key,
        // Wrapped rather than passed by reference: the offer owns the native
        // id and the at-most-once guard, and this keeps `this` bound to it.
        respond: (result: JsonValue) => request.respond(result),
        applied: undefined,
      });
      sink.emit({
        payload: {
          type: 'interaction.requested',
          providerRef,
          request: {
            kind: 'approval',
            subject: translation.subject,
            allowedModes: [...CODEX_APPROVAL_MODES],
            // A UX ordering hint, not a security classification: this is
            // provider-declared intent and the runtime enforces nothing
            // (ADR-0009).
            riskHint: 'high',
          },
        },
      });
      return 'taken';
    },

    settle(providerRef: string, response: InteractionResponse): void {
      const entry = entries.get(providerRef);
      if (entry === undefined) {
        // The reference is caller-controlled text on a durable error, so it is
        // classified, never echoed.
        throw rejection('unknown_interaction', 'the codex adapter has no interaction outstanding for that reference');
      }
      const parsed = InteractionResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw rejection('invalid_request', 'the codex interaction response is malformed');
      }
      response = parsed.data;

      if (entry.kind === 'question') {
        if (response.kind !== 'question_set') {
          throw rejection('capability_unsupported', 'this codex interaction is answered with a question batch', {
            capability: 'interaction.kind',
            supported: ['question_set'],
          });
        }
        // Validation completes before settlement is consumed, so a response
        // this adapter cannot apply leaves the batch answerable.
        const native = nativeUserInputAnswers(entry.plan, response);
        const questionKey = appliedQuestionKey(response);
        if (entry.applied !== undefined) {
          if (entry.applied === questionKey) return;
          throw rejection('interaction_already_settled', 'this codex question is already settled');
        }
        entry.applied = questionKey;
        entry.respond(native);
        return;
      }

      if (response.kind !== 'approval') {
        throw rejection(
          'capability_unsupported',
          'the codex adapter bridges approval interactions only; it raises no question',
          { capability: 'interaction.kind', supported: ['approval'] },
        );
      }
      if (response.decision === 'approved') {
        if (response.mode === undefined) {
          throw rejection('invalid_request', 'an approval must state the mode it was granted under');
        }
        if (response.mode !== 'once' && response.mode !== 'session') {
          throw rejection('capability_unsupported', 'the codex app-server cannot express that approval mode', {
            capability: 'interaction.approval.modes',
            supported: [...CODEX_APPROVAL_MODES],
          });
        }
      }

      if (response.decision === 'denied' && response.mode !== undefined) {
        throw rejection('invalid_request', 'a denial must not carry an approval mode');
      }

      // Validation completes before settlement is consumed, so a response this
      // adapter cannot apply leaves the approval answerable rather than burning
      // its single settlement on an answer nobody can act on.
      const key = appliedKey(response);
      if (entry.applied !== undefined) {
        if (entry.applied === key) return;
        throw rejection('interaction_already_settled', 'this codex approval is already settled');
      }
      entry.applied = key;
      entry.respond({ decision: nativeDecision(response) });
    },

    retire(key: object): void {
      clear(key);
    },

    retireAll(): void {
      clear(undefined);
    },

    get trackedCount(): number {
      return entries.size;
    },
  };
}
