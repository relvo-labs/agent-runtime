/**
 * The host question bridge.
 *
 * `AskUserQuestion` is how the Claude Agent SDK asks a *clarifying* question
 * mid-run. It reaches the host through the same `canUseTool` callback as a
 * permission prompt, and the SDK blocks on the returned promise — so the run
 * does not end, does not ask again next turn, and resumes at exactly the point
 * it paused once this module answers.
 *
 * The answer route is the pinned `AskUserQuestionInput.answers` map:
 *
 * ```ts
 * { behavior: 'allow', updatedInput: { questions, answers: { [questionText]: answerString } } }
 * ```
 *
 * `answers` is declared in `@anthropic-ai/claude-agent-sdk@0.3.259`'s generated
 * tool schemas as "User answers collected by the permission component", and the
 * CLI hands the same map back as `AskUserQuestionOutput.answers`. This is a
 * structured tool path, not an approval: a bare `{behavior:'allow'}` would run
 * the tool with no answers at all, and `{behavior:'deny', message}` would hand
 * the model prose. Neither is ever used here to settle a question.
 *
 * Five properties this module is responsible for:
 *
 *  1. **Whole-batch or nothing.** One `AskUserQuestion` call is one neutral
 *     `question_set` interaction. Every question is carried, and the single
 *     neutral response is turned into the whole native answer map in one
 *     callback return. There is no path that answers some questions.
 *  2. **Lossless or refused.** A call carrying a fact this adapter cannot
 *     represent — an option preview, an ambiguous duplicate question text or
 *     option label, a count outside the pinned bounds, pre-filled answers — is
 *     denied whole, on its own callback, and raises nothing. Silently dropping
 *     a fact would change what the user believes they are answering.
 *  3. **Nothing native, nothing sensitive, escapes.** Question keys are this
 *     adapter's own ordinals, never the SDK's `toolUseID`, `requestId` or the
 *     question text the native map is keyed by. Refusal diagnostics are bounded
 *     tokens; no prompt, option or answer text reaches an error or a log.
 *  4. **Exactly once, in process.** A reference settles one callback one time.
 *     An identical redelivery is a no-op; a different answer is refused.
 *  5. **No dangling callback.** Every entry belongs to a run. When that run
 *     ends, or when the SDK withdraws the call by aborting its signal, the
 *     entry is denied once, detached and retired.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { agentError, type InteractionResponse, type JsonObject, type QuestionItem } from '@relvo-labs/agent-protocol';
import { ProviderRejection, type ProviderEventSink } from '@relvo-labs/agent-provider';

import type { ClaudePermissionResult } from './seam.ts';

/** The tool name the SDK routes a clarifying question through. */
export const CLAUDE_QUESTION_TOOL = 'AskUserQuestion';

/** Shown to the model when the run that asked went away unanswered. */
const TEARDOWN_DENIAL = 'the run that asked this question ended before it was answered';
/** Shown when the SDK withdrew the call before anyone answered it. */
const CANCELLED_DENIAL = 'claude withdrew this question before it was answered';
/** Marks an entry retired without an answer; never equal to an applied key. */
const RETIRED = 'retired';

/**
 * Bounds from the pinned `AskUserQuestionInput` declaration: 1–4 questions,
 * each with 2–4 options. They are enforced rather than assumed, because the
 * tool input is model-authored text arriving from another process.
 */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * How multi-select answers are encoded in the native map.
 *
 * The pinned `AskUserQuestionInput.answers` value type is `string`, and the
 * matching `AskUserQuestionOutput.answers` is documented as
 * "multi-select answers are comma-separated". Joining is therefore the pinned
 * encoding, not a convenience.
 */
const MULTI_SELECT_JOIN = ', ';

/**
 * Why a call could not be bridged.
 *
 * Bounded tokens, never upstream prose: these reach a durable diagnostic and
 * the tool input is model-authored text.
 */
export type QuestionRefusal =
  | 'malformed'
  | 'question_count'
  | 'option_count'
  | 'duplicate_question'
  | 'duplicate_option'
  | 'preview_unsupported'
  | 'answers_prefilled';

/**
 * Private native schema for the pinned `AskUserQuestionInput`.
 *
 * Closed deliberately: an unknown member means the tool grew a fact this
 * adapter has not been taught to carry, and carrying on would drop it.
 */
const AskUserQuestionOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string(),
  preview: z.string().optional(),
});

const AskUserQuestionQuestionSchema = z.strictObject({
  question: z.string().min(1),
  header: z.string(),
  options: z.array(AskUserQuestionOptionSchema),
  multiSelect: z.boolean(),
});

const AskUserQuestionInputSchema = z.strictObject({
  questions: z.array(AskUserQuestionQuestionSchema),
  answers: z.record(z.string(), z.string()).optional(),
  annotations: z
    .record(z.string(), z.strictObject({ preview: z.string().optional(), notes: z.string().optional() }))
    .optional(),
  metadata: z.strictObject({ source: z.string().optional() }).optional(),
});

type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

/**
 * What a bridged call looks like once translated.
 *
 * `plan` is the adapter-private mapping from neutral keys back to the native
 * question text and option labels the answer map must be built from. It never
 * leaves this module.
 */
export type QuestionPlanEntry = {
  readonly key: string;
  /** Native answer-map key. Adapter-private. */
  readonly questionText: string;
  readonly multiSelect: boolean;
  /** Neutral choice value → native option label. */
  readonly labels: ReadonlyMap<string, string>;
};

export type QuestionTranslation =
  | {
      readonly kind: 'request';
      readonly questions: readonly QuestionItem[];
      readonly plan: readonly QuestionPlanEntry[];
      readonly input: AskUserQuestionInput;
    }
  | { readonly kind: 'refused'; readonly reason: QuestionRefusal };

function refused(reason: QuestionRefusal): QuestionTranslation {
  return { kind: 'refused', reason };
}

/**
 * Validate one complete `AskUserQuestion` input and map it to a neutral batch.
 *
 * Everything is checked before anything is admitted, so a call this adapter
 * cannot answer faithfully never becomes routing state.
 */
export function translateAskUserQuestion(input: unknown): QuestionTranslation {
  const parsed = AskUserQuestionInputSchema.safeParse(input);
  if (!parsed.success) return refused('malformed');
  const native = parsed.data;

  // Host-supplied fields arriving on the way *in* mean either a producer this
  // recording does not describe, or an attempt to pre-answer. Either way the
  // host has not answered yet, so answering as if it had would be a fabrication.
  if (native.answers !== undefined || native.annotations !== undefined) return refused('answers_prefilled');

  if (native.questions.length === 0 || native.questions.length > MAX_QUESTIONS) return refused('question_count');

  const seenQuestions = new Set<string>();
  const questions: QuestionItem[] = [];
  const plan: QuestionPlanEntry[] = [];

  for (const [index, question] of native.questions.entries()) {
    if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
      return refused('option_count');
    }
    // The native answer map is keyed by question *text*, so two questions with
    // the same text cannot both be answered. Refuse rather than overwrite one.
    if (seenQuestions.has(question.question)) return refused('duplicate_question');
    seenQuestions.add(question.question);

    const labels = new Map<string, string>();
    const seenLabels = new Set<string>();
    const choices: { value: string; label: string; description?: string }[] = [];
    for (const [optionIndex, option] of question.options.entries()) {
      // A preview is generated only when `toolConfig.askUserQuestion.previewFormat`
      // is set, which this adapter never sets. One arriving anyway is a fact
      // the neutral choice cannot carry.
      if (option.preview !== undefined) return refused('preview_unsupported');
      // The answer is the label, so duplicate labels are an ambiguous answer.
      if (seenLabels.has(option.label)) return refused('duplicate_option');
      seenLabels.add(option.label);

      const value = `o${String(optionIndex + 1)}`;
      labels.set(value, option.label);
      choices.push({
        value,
        label: option.label,
        ...(option.description === '' ? {} : { description: option.description }),
      });
    }

    // The adapter's own ordinal. The native key is the question text, which is
    // content rather than identity, and must not become a correlation token a
    // caller can address the SDK's internals with.
    const key = `q${String(index + 1)}`;
    questions.push({
      key,
      prompt: question.question,
      ...(question.header === '' ? {} : { header: question.header }),
      choices,
      multiSelect: question.multiSelect,
      // The SDK's own guidance is that a host offers an "Other" affordance and
      // sends the typed text as the answer value, so free text is always
      // acceptable here — the answer map takes an arbitrary string.
      allowFreeText: true,
      // `AskUserQuestion` has no secret-answer concept.
      sensitive: false,
    });
    plan.push({ key, questionText: question.question, multiSelect: question.multiSelect, labels });
  }

  return { kind: 'request', questions, plan, input: native };
}

/**
 * Build the native answer map from one validated neutral response.
 *
 * The caller has already proven the response answers every question exactly
 * once (`checkResponseAgainstRequest`), so this cannot produce a partial map.
 */
export function nativeAnswers(
  plan: readonly QuestionPlanEntry[],
  response: Extract<InteractionResponse, { kind: 'question_set' }>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const entry of plan) {
    const answer = response.answers[entry.key];
    if (answer === undefined) {
      throw rejection('invalid_request', 'every question in this claude batch must be answered');
    }
    if (answer.type === 'text') {
      answers[entry.questionText] = answer.text;
      continue;
    }
    const labels = answer.values.map((value) => entry.labels.get(value));
    if (labels.some((label) => label === undefined)) {
      throw rejection('invalid_request', 'a selection named a choice this claude question does not offer');
    }
    answers[entry.questionText] = (labels as string[]).join(MULTI_SELECT_JOIN);
  }
  return answers;
}

function rejection(code: Parameters<typeof agentError>[0], message: string, details?: JsonObject): ProviderRejection {
  return new ProviderRejection(agentError(code, message, details === undefined ? {} : { details }));
}

type Entry = {
  /** The run that owns this question. Identity only; never inspected here. */
  readonly owner: object;
  readonly settle: (result: ClaudePermissionResult) => void;
  readonly plan: readonly QuestionPlanEntry[];
  readonly input: AskUserQuestionInput;
  /** Canonicalized applied answer, telling redelivery from conflict. */
  applied: string | undefined;
  /** Detaches this entry's cancellation listener. Runs exactly once. */
  release: (() => void) | undefined;
};

export type QuestionRegistry = {
  /**
   * Raise a batch for `owner` and resolve when it is settled.
   *
   * The returned promise is what the SDK is waiting on, so it always resolves —
   * never rejects, and never with `null`, which the SDK reads as "answered out
   * of band" and would leave the tool blocked forever.
   */
  request(
    owner: object,
    sink: ProviderEventSink,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ClaudePermissionResult>;
  /** Apply one settled neutral response. Throws `ProviderRejection` if it cannot. */
  settle(providerRef: string, response: InteractionResponse): boolean;
  /** Deny and forget everything `owner` raised. Safe to call more than once. */
  cancel(owner: object): void;
  /** Deny and forget everything, for session teardown. */
  cancelAll(): void;
};

/** Canonical form of an applied answer, used to tell redelivery from conflict. */
function appliedKey(response: Extract<InteractionResponse, { kind: 'question_set' }>): string {
  // Key order is not semantic, so it is normalized before comparison: the same
  // answers collected in a different order are the same answer.
  return JSON.stringify(
    Object.keys(response.answers)
      .sort()
      .map((key) => [key, response.answers[key]]),
  );
}

export function createQuestionRegistry(): QuestionRegistry {
  const entries = new Map<string, Entry>();
  /**
   * This registry's own reference namespace. A bare counter would name every
   * session's first question identically, letting a caller driving the SPI
   * directly settle another session's question by guessing `question-1`.
   */
  const namespace = randomUUID();
  let issued = 0;

  function retire(providerRef: string, entry: Entry, message: string): void {
    entries.delete(providerRef);
    entry.release?.();
    entry.release = undefined;
    if (entry.applied !== undefined) return;
    entry.applied = RETIRED;
    entry.settle({ behavior: 'deny', message });
  }

  function clear(owner: object | undefined): void {
    for (const [providerRef, entry] of [...entries]) {
      if (owner !== undefined && entry.owner !== owner) continue;
      retire(providerRef, entry, TEARDOWN_DENIAL);
    }
  }

  return {
    request(
      owner: object,
      sink: ProviderEventSink,
      input: unknown,
      signal: AbortSignal | undefined,
    ): Promise<ClaudePermissionResult> {
      // Already withdrawn: answer it and raise nothing. Emitting here would ask
      // a host to answer something the SDK has stopped listening for.
      if (signal?.aborted === true) {
        return Promise.resolve({ behavior: 'deny', message: CANCELLED_DENIAL });
      }

      const translation = translateAskUserQuestion(input);
      if (translation.kind === 'refused') {
        sink.emit({
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: `claude asked a question this adapter cannot represent (${translation.reason}); it was declined`,
          },
        });
        return Promise.resolve({
          behavior: 'deny',
          message: 'this host cannot display that question faithfully; ask in your reply instead',
        });
      }

      issued += 1;
      const providerRef = `question-${namespace}-${String(issued)}`;

      return new Promise<ClaudePermissionResult>((resolve) => {
        const entry: Entry = {
          owner,
          settle: resolve,
          plan: translation.plan,
          input: translation.input,
          applied: undefined,
          release: undefined,
        };
        entries.set(providerRef, entry);
        if (signal !== undefined) {
          const onAbort = (): void => {
            retire(providerRef, entry, CANCELLED_DENIAL);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entry.release = () => {
            signal.removeEventListener('abort', onAbort);
          };
        }
        sink.emit({
          payload: {
            type: 'interaction.requested',
            providerRef,
            request: { kind: 'question_set', questions: [...translation.questions] },
          },
        });
      });
    },

    settle(providerRef: string, response: InteractionResponse): boolean {
      const entry = entries.get(providerRef);
      // Not this registry's reference. The caller decides what that means; the
      // reference itself is never echoed, being caller-controlled text on a
      // durable error.
      if (entry === undefined) return false;

      if (response.kind !== 'question_set') {
        throw rejection('capability_unsupported', 'the claude adapter answers this interaction with a question batch', {
          capability: 'interaction.kind',
          supported: ['question_set'],
        });
      }

      // Validation completes before settlement is consumed, so a response this
      // adapter cannot apply leaves the question answerable rather than burning
      // its single settlement on an answer nobody can act on.
      const answers = nativeAnswers(entry.plan, response);
      const key = appliedKey(response);
      if (entry.applied !== undefined) {
        if (entry.applied === key) return true;
        throw rejection('interaction_already_settled', 'this claude question is already settled');
      }
      entry.applied = key;
      entry.release?.();
      entry.release = undefined;
      entry.settle({
        behavior: 'allow',
        // `questions` is passed back because the pinned tool requires the
        // original array alongside the answers to process them.
        updatedInput: {
          questions: entry.input.questions,
          answers,
          ...(entry.input.metadata === undefined ? {} : { metadata: entry.input.metadata }),
        },
      });
      return true;
    },

    cancel(owner: object): void {
      clear(owner);
    },

    cancelAll(): void {
      clear(undefined);
    },
  };
}
