/**
 * The interaction bridge: pinned native request shapes, neutral interactions.
 *
 * The app-server asks the client to decide things and to ask the user things.
 * This module decides which of those can be put to a host **without losing
 * anything**, turns exactly those into the neutral `interaction.requested` the
 * protocol already defines, and declines the rest on their own native request
 * id.
 *
 * Each bridge is opted into separately (`InteractionRegistryOptions`). A
 * session that enabled questions still declines command approvals, because a
 * question is the model asking the *user* something and an approval is the
 * model asking permission to *act*.
 *
 * ## The mapping table, pinned to codex-cli 0.153.4 (stable surface only)
 *
 * | `ServerRequest` method                   | Bridged | Why                                                                                                                          |
 * | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
 * | `item/commandExecution/requestApproval`  | **with `approvals: 'bridge'`** | Carries its own reviewable subject (`command`, `cwd`, `reason`), and `accept`/`acceptForSession`/`decline` map onto `once`/`session`/denied. |
 * | `item/tool/requestUserInput`             | **with `questions: 'bridge'`** | A keyed question *list*, which `question_set` carries exactly: native `id` → adapter key, `header`, `options` → choices, `isOther` → `allowFreeText`, `isSecret` → `sensitive` (ADR-0018). It is **not** gated behind `InitializeCapabilities.experimentalApi`: the pinned stable dump contains `ToolRequestUserInput*` byte-identical to the experimental one while genuinely experimental methods are filtered out of it, so `capabilities: null` is both sufficient and safer. |
 * | `item/fileChange/requestApproval`        | no      | `FileChangeRequestApprovalParams` names no files. The change set lives in the `itemId` item, which this adapter does not surface (`streaming.toolActivity: false`), so the approval would have no reviewable subject. |
 * | `item/permissions/requestApproval`       | no      | `PermissionsRequestApprovalResponse` requires a `GrantedPermissionProfile` and a `PermissionGrantScope`, and has no decline variant at all. A neutral approval response carries a decision and a mode. |
 * | `mcpServer/elicitation/request`          | no      | An arbitrary multi-field form (`McpElicitationSchema`), with a *nullable* `turnId` — so neither the one-question mapping nor run correlation holds. |
 * | `item/tool/call`                         | no      | Asks the client to execute a tool. Not an interaction.                                                                        |
 * | `account/chatgptAuthTokens/refresh`      | no      | A credential operation. This adapter holds no credentials.                                                                    |
 * | `attestation/generate`                   | no      | Requires `InitializeCapabilities.requestAttestation`, which is never sent.                                                    |
 * | `applyPatchApproval` (legacy)            | no      | Carries `conversationId` / `callId` and **no `turnId`**, so it cannot be bound to the active run.                              |
 * | `execCommandApproval` (legacy)           | no      | Same: no `turnId`, so it cannot be correlated.                                                                                |
 *
 * `serverRequest/resolved` is a *notification*, not a request, and is the one
 * inbound frame that retires an entry without a reply: see `resolveNative`.
 *
 * ## What this module guarantees
 *
 *  1. **No silent drop and no automatic approval.** Every request is answered
 *     exactly once — by a host decision, by an explicit typed decline, or by a
 *     `decline` at teardown — unless the server retires it itself with
 *     `serverRequest/resolved`, in which case nothing is written at all.
 *     Nothing is granted that a host did not grant.
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
  checkResponseAgainstRequest,
  InteractionResponseSchema,
  QuestionSetRequestSchema,
  type ApprovalRequest,
  type InteractionResponse,
  type JsonObject,
  type JsonValue,
  type QuestionItem,
  type QuestionSetRequest,
} from '@relvo-labs/agent-protocol';
import { ProviderRejection, type ProviderEventSink } from '@relvo-labs/agent-provider';

import { INVALID_PARAMS, INVALID_REQUEST } from './protocol.ts';
import type { CodexRequestId } from './seam.ts';
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
  | 'detail_too_large'
  /**
   * Well formed for the app-server, invalid as a neutral batch: a prompt,
   * header, option label or description past its bound, or an option count
   * above the neutral maximum. `ToolRequestUserInputParams` declares no
   * lengths and no option limit, so only the neutral schema can say.
   */
  | 'neutral_bounds';

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
      /**
       * The complete neutral request, already parsed by
       * `QuestionSetRequestSchema`. Retaining the whole validated request is
       * what makes settlement checkable against what was asked, and what
       * guarantees the runtime is never handed a batch it would discard as a
       * malformed provider event while the app-server waits forever.
       */
      readonly request: QuestionSetRequest;
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

  // The aggregate bound above says nothing about an individual field. An
  // 8001-character prompt is comfortably inside 16000 characters of batch JSON
  // and outside `QuestionItem.prompt`; 65 options is a legal native list and an
  // illegal neutral choice list. The neutral schema is therefore the last gate,
  // applied to the whole translated request before any entry is retained or
  // any event emitted.
  const parsedRequest = QuestionSetRequestSchema.safeParse({ kind: 'question_set', questions });
  if (!parsedRequest.success) return refusedQuestion('neutral_bounds');

  return {
    kind: 'request',
    correlation: { threadId: record.threadId, turnId: record.turnId },
    request: parsedRequest.data,
    plan,
  };
}

/**
 * Build the native answer map from one validated neutral response.
 *
 * The runtime has already proven the response answers every question exactly
 * once, so this cannot produce a partial map — and it throws rather than
 * omitting a key if that guarantee is ever violated by a direct SPI caller.
 *
 * Assembled with `Object.fromEntries`, which defines each key as an **own data
 * property**. The native key is the server's question `id`, an arbitrary
 * string: `answers[id] = …` would reassign the object's prototype for an `id`
 * of `__proto__` and serialise as `{"answers":{}}` — a reply that answers
 * nothing while this adapter reports the batch settled.
 */
export function nativeUserInputAnswers(
  plan: readonly QuestionPlanEntry[],
  response: Extract<InteractionResponse, { kind: 'question_set' }>,
): JsonObject {
  const pairs: [string, JsonValue][] = [];
  for (const entry of plan) {
    const answer = response.answers[entry.key];
    if (answer === undefined) {
      throw rejection('invalid_request', 'every question in this codex batch must be answered');
    }
    if (answer.type === 'text') {
      pairs.push([entry.questionId, { answers: [answer.text] }]);
      continue;
    }
    const labels = answer.values.map((value) => entry.labels.get(value));
    if (labels.some((label) => label === undefined)) {
      throw rejection('invalid_request', 'a selection named a choice this codex question does not offer');
    }
    pairs.push([entry.questionId, { answers: labels as string[] }]);
  }
  return { answers: Object.fromEntries(pairs) };
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
 * The client layer still owns the reply: `respond`/`reject` are the only way to
 * write on this id, and they answer at most once. The `id` itself is carried
 * because `serverRequest/resolved` correlates by native request id and by
 * nothing else — there is no `turnId` on it — so a registry that cannot see the
 * id cannot tell which of its entries the server just retired. It is
 * adapter-private, compared and never published: no neutral event, error or
 * diagnostic in this module carries it.
 */
export type CodexServerRequestOffer = {
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params: unknown;
  /** Mark server-side resolution without writing a reply. Idempotent. */
  retire(): void;
  /** Answer with a result. Returns false if it was already answered or retired. */
  respond(result: JsonValue): boolean;
  /** Answer with a JSON-RPC error. Returns false if already answered or retired. */
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
  /**
   * The server resolved one of its own requests (`serverRequest/resolved`).
   *
   * Two cases, both handled without writing anything on that native id:
   *
   *  - the entry was already answered by a host — this is the server
   *    *confirming* that answer, and the entry is simply forgotten;
   *  - the entry was never answered — the server has withdrawn it, so the
   *    entry is fenced against any later reply and the Runtime interaction it
   *    raised is withdrawn, freeing the run.
   *
   * An id this registry never tracked is ignored: it names another client's
   * request or one already retired.
   */
  resolveNative(requestId: CodexRequestId): void;
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
  /**
   * The native request id this entry answers. Adapter-private correlation for
   * `serverRequest/resolved`; never published and never echoed.
   */
  readonly nativeId: CodexRequestId;
  /** The run's own sink, so a withdrawal reaches the run that asked. */
  readonly sink: ProviderEventSink;
  /** The adapter's correlation token, echoed on a withdrawal. */
  readonly providerRef: string;
  readonly respond: (result: JsonValue) => boolean;
  readonly retire: () => void;
  /**
   * The answer already applied, canonicalized. Present means the one native
   * callback has been used: identical redelivery is a no-op, a different answer
   * is a conflict, and neither reaches the server twice.
   */
  applied: string | undefined;
} & (
  | { readonly kind: 'approval'; readonly request: ApprovalRequest; readonly plan?: undefined }
  | { readonly kind: 'question'; readonly request: QuestionSetRequest; readonly plan: readonly QuestionPlanEntry[] }
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
   * Whether `item/commandExecution/requestApproval` is bridged. When false the
   * method is reported `unhandled` and the caller declines it with `-32601`,
   * which is the fail-closed posture a provider that declares no approval
   * capability must keep.
   *
   * Independent of `questions` on purpose: a question is the model asking the
   * *user* something, and an approval is the model asking permission to *act*.
   * Enabling the first must never quietly enable the second.
   */
  readonly approvals: boolean;
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
  options: InteractionRegistryOptions = { approvals: true, questions: false },
): CodexInteractionRegistry {
  const bridgesApprovals = options.approvals;
  const bridgesQuestions = options.questions;
  const entries = new Map<string, Entry>();
  /**
   * Native request id → this registry's reference.
   *
   * `serverRequest/resolved` names a request by native id and carries no turn,
   * so without this map a resolution cannot be attributed to an entry at all.
   * It is maintained in lockstep with `entries`, so it is bounded by the same
   * `MAX_TRACKED_APPROVALS`.
   */
  const byNativeId = new Map<CodexRequestId, string>();
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
    byNativeId.delete(entry.nativeId);
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
      nativeId: request.id,
      sink,
      providerRef,
      request: translation.request,
      plan: translation.plan,
      respond: (result: JsonValue) => request.respond(result),
      retire: () => {
        request.retire();
      },
      applied: undefined,
    });
    byNativeId.set(request.id, providerRef);
    sink.emit({ payload: { type: 'interaction.requested', providerRef, request: translation.request } });
    return 'taken';
  }

  return {
    offer(request: CodexServerRequestOffer, owner: ApprovalOwner | undefined): OfferVerdict {
      if (request.method === CODEX_BRIDGED_QUESTION) {
        if (!bridgesQuestions) return 'unhandled';
        return offerQuestion(request, owner);
      }
      // Each native method is gated by its *own* flag. A session that only
      // asked for questions still declines every command approval with
      // `-32601`, matching the `approval: {}` capability it advertises.
      if (request.method !== CODEX_BRIDGED_APPROVAL || !bridgesApprovals) return 'unhandled';

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
      const approvalRequest: ApprovalRequest = {
        kind: 'approval',
        subject: translation.subject,
        allowedModes: [...CODEX_APPROVAL_MODES],
        // A UX ordering hint, not a security classification: this is
        // provider-declared intent and the runtime enforces nothing
        // (ADR-0009).
        riskHint: 'high',
      };
      entries.set(providerRef, {
        kind: 'approval',
        ownerKey: owner.key,
        nativeId: request.id,
        sink,
        providerRef,
        request: approvalRequest,
        // Wrapped rather than passed by reference: the offer owns the native
        // id and the at-most-once guard, and this keeps `this` bound to it.
        respond: (result: JsonValue) => request.respond(result),
        retire: () => {
          request.retire();
        },
        applied: undefined,
      });
      byNativeId.set(request.id, providerRef);
      sink.emit({ payload: { type: 'interaction.requested', providerRef, request: approvalRequest } });
      return 'taken';
    },

    resolveNative(requestId: CodexRequestId): void {
      const providerRef = byNativeId.get(requestId);
      if (providerRef === undefined) return;
      // The native id is retired either way: the server will not use it again,
      // and a second resolution must not find an entry a third time.
      byNativeId.delete(requestId);
      const entry = entries.get(providerRef);
      if (entry === undefined) return;
      // Correlation is established by the session's thread check and this
      // registry's native-id lookup. Retire the client ledger too: overflow
      // cleanup must never write a rejection to a server-resolved request.
      entry.retire();
      // Already answered: this is the server confirming the reply this adapter
      // already wrote. Harmless, and the entry stays tracked so an identical
      // redelivery of that answer remains a no-op rather than becoming an
      // `unknown_interaction`. Writing on the id again is what would be wrong.
      if (entry.applied !== undefined) return;
      // Never answered: the server resolved it by itself. Fence the entry so a
      // later response cannot write on a retired native id, and tell the
      // Runtime, which is otherwise left holding a pending interaction and a
      // run parked in `awaiting_interaction` for the rest of its life.
      entries.delete(providerRef);
      entry.applied = RETIRED;
      entry.sink.emit({ payload: { type: 'interaction.withdrawn', providerRef: entry.providerRef } });
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
        // `respondToInteraction` is public SPI, so the full request-aware
        // check runs here too and not only inside the Runtime: exact key set,
        // cardinality, duplicate selections, known choice values, and free
        // text only where `isOther` (or an option-less question) permitted it.
        // The reason is a bounded classification; it never carries an answer
        // value or an unknown key.
        const mismatch = checkResponseAgainstRequest(entry.request, response);
        if (mismatch !== undefined) {
          throw rejection('invalid_request', `this codex question batch was answered invalidly: ${mismatch}`);
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

      // The same request-aware backstop the question branch applies, run after
      // the capability-specific checks above so the more precise classification
      // wins. It is redundant only for as long as this adapter's
      // `allowedModes` and `CODEX_APPROVAL_MODES` stay identical.
      const approvalMismatch = checkResponseAgainstRequest(entry.request, response);
      if (approvalMismatch !== undefined) {
        throw rejection('invalid_request', `this codex approval was answered invalidly: ${approvalMismatch}`);
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
