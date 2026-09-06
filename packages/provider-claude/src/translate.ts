/**
 * SDK message → provider event translation.
 *
 * Everything here is pure and synchronous so the mapping can be characterized
 * exactly, message by message, without a process, a socket or a clock.
 *
 * Three rules hold for every branch below:
 *
 *  1. Only payload shapes the protocol already defines are produced. This
 *     adapter adds no wire variant.
 *  2. Provider-native identity — session ids, message uuids, tool-use ids —
 *     is read, used for correlation, and then dropped. It never reaches an
 *     emitted payload.
 *  3. An unrecognised message is ignored. The SDK is a separate process whose
 *     output is untrusted input; a shape this adapter does not know must not be
 *     able to crash a run or forge an event.
 */

import { agentError, type ProviderEventInput } from '@relvo-labs/agent-protocol';
import type { ProviderRunTermination } from '@relvo-labs/agent-provider';

import type { ClaudeQueryMessage } from './seam.ts';

/** `run.message_delta.text` is bounded by the protocol; longer text is split. */
export const MAX_DELTA_CHARS = 100_000;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * Credential shapes that must never be copied out of a provider process into a
 * durable event log. The adapter cannot know what an upstream error string
 * contains, so it redacts before it records.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}/gu,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];

export function redact(value: string): string {
  let result = value;
  for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

export type RunTranslation = {
  /** Semantic payloads to emit, in order. */
  readonly events: readonly ProviderEventInput[];
  /** Present only on the message that ends the run. */
  readonly termination?: ProviderRunTermination;
};

export type RunTranslator = {
  translate(message: ClaudeQueryMessage): RunTranslation;
};

// ---------------------------------------------------------------------------
// Narrowing helpers — every one of these takes `unknown` on purpose
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function blocksOf(message: unknown): readonly Readonly<Record<string, unknown>>[] {
  const body = asRecord(asRecord(message)?.message);
  const content = body?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block): block is Readonly<Record<string, unknown>> => block !== undefined);
}

function chunk(text: string): readonly string[] {
  if (text.length <= MAX_DELTA_CHARS) return [text];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    parts.push(text.slice(index, index + MAX_DELTA_CHARS));
  }
  return parts;
}

function failureDetail(message: ClaudeQueryMessage): string | undefined {
  const errors = message.errors;
  const parts = Array.isArray(errors)
    ? errors.map(asString).filter((entry): entry is string => entry !== undefined)
    : [];
  const joined = parts.join('; ').trim();
  if (joined === '') return undefined;
  const redacted = redact(joined);
  return redacted.length > MAX_FAILURE_DETAIL_CHARS ? `${redacted.slice(0, MAX_FAILURE_DETAIL_CHARS)}…` : redacted;
}

function usageEvent(message: ClaudeQueryMessage): ProviderEventInput | undefined {
  const usage = asRecord(message.usage);
  if (usage === undefined) return undefined;
  const inputTokens = asTokenCount(usage.input_tokens);
  const outputTokens = asTokenCount(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    payload: {
      type: 'run.usage',
      usage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Create a translator for one run.
 *
 * The only state it keeps is the native tool-use id → tool name map needed to
 * report a tool result under the name the caller already saw. That map is
 * per-run and never leaves this object.
 */
export function createRunTranslator(): RunTranslator {
  const toolNames = new Map<string, string>();

  function translateAssistant(message: ClaudeQueryMessage): readonly ProviderEventInput[] {
    const events: ProviderEventInput[] = [];
    const assistantError = asString(message.error);
    for (const block of blocksOf(message)) {
      const type = asString(block.type);
      if (type === 'text') {
        const text = asString(block.text) ?? '';
        for (const part of chunk(text)) {
          if (part !== '') events.push({ payload: { type: 'run.message_delta', text: part } });
        }
        continue;
      }
      if (type !== 'tool_use') continue;
      const name = asString(block.name)?.slice(0, MAX_TOOL_NAME_CHARS);
      const id = asString(block.id);
      if (name === undefined || name === '') continue;
      if (id !== undefined) toolNames.set(id, name);
      // The tool's arguments are deliberately not summarised: they routinely
      // contain file contents and command lines from the workspace.
      events.push({ payload: { type: 'run.tool_activity', toolName: name, phase: 'invoked' } });
    }
    if (assistantError !== undefined) {
      events.push({
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: `claude reported an assistant error: ${redact(assistantError).slice(0, 200)}`,
        },
      });
    }
    return events;
  }

  function translateToolResults(message: ClaudeQueryMessage): readonly ProviderEventInput[] {
    const events: ProviderEventInput[] = [];
    for (const block of blocksOf(message)) {
      if (asString(block.type) !== 'tool_result') continue;
      const id = asString(block.tool_use_id);
      if (id === undefined) continue;
      const toolName = toolNames.get(id);
      // A result for a tool this run never reported cannot be attributed, and
      // inventing a name would be worse than staying silent.
      if (toolName === undefined) continue;
      toolNames.delete(id);
      events.push({
        payload: {
          type: 'run.tool_activity',
          toolName,
          phase: block.is_error === true ? 'failed' : 'succeeded',
        },
      });
    }
    return events;
  }

  function translateResult(message: ClaudeQueryMessage): RunTranslation {
    const usage = usageEvent(message);
    const events = usage === undefined ? [] : [usage];
    const subtype = message.subtype;
    const failed = subtype !== 'success' || message.is_error === true;
    if (!failed) return { events, termination: { outcome: 'succeeded' } };

    const detail = failureDetail(message);
    return {
      events,
      termination: {
        outcome: 'failed',
        error: agentError(
          'provider_rejected',
          `claude run failed (${subtype ?? 'unknown result'})${detail === undefined ? '' : `: ${detail}`}`,
          subtype === undefined ? {} : { providerCode: subtype.slice(0, 200) },
        ),
      },
    };
  }

  return {
    translate(message: ClaudeQueryMessage): RunTranslation {
      // `message.session_id` and every other native identifier is deliberately
      // left where it arrived: nothing here reads it, so nothing can emit it.
      switch (message.type) {
        case 'assistant':
          return { events: translateAssistant(message) };
        case 'user':
          return { events: translateToolResults(message) };
        case 'result':
          return translateResult(message);
        default:
          // `stream_event`, `system`, and everything the SDK adds later.
          return { events: [] };
      }
    },
  };
}
