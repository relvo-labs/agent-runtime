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
 *  4. Upstream prose is never copied into a public string. Every message and
 *     provider code published from here comes from a closed allowlist, because
 *     an `AgentError` is durable and an SDK error can be carrying a credential,
 *     a native id, a path or the prompt itself. A host that needs the raw text
 *     wraps `query` in its own binding, where it sees every SDK message and
 *     error without any of it reaching the event log.
 */

import { agentError, type ProviderEventInput } from '@relvo-labs/agent-protocol';
import type { ProviderRunTermination } from '@relvo-labs/agent-provider';

import type { ClaudeQueryMessage } from './seam.ts';

/** `run.message_delta.text` is bounded by the protocol; longer text is split. */
export const MAX_DELTA_CHARS = 100_000;
const MAX_TOOL_NAME_CHARS = 200;

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

/**
 * Result subtypes the pinned SDK declares. Anything else is reported under one
 * fixed code rather than published verbatim.
 */
const RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

const UNRECOGNIZED_RESULT = 'unrecognized_result';

/** `SDKAssistantMessageError` — a closed enum in the pinned SDK. */
const ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'model_not_found',
  'server_error',
  'unknown',
  'max_output_tokens',
]);

/**
 * System-level causes worth naming publicly. These are bounded identifiers, not
 * prose: a value outside the set becomes `unknown` rather than being copied.
 */
const THROWN_CAUSES: ReadonlySet<string> = new Set([
  'ABORT_ERR',
  'EACCES',
  'ECONNRESET',
  'ENOENT',
  'EPERM',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ETIMEDOUT',
]);

/** Classify a thrown value into one allowlisted token. Never its message. */
export function classifyThrown(error: unknown): string {
  const record = asRecord(error);
  const code = asString(record?.code);
  if (code !== undefined && THROWN_CAUSES.has(code)) return code;
  const name = asString(record?.name);
  if (name === 'AbortError') return 'ABORT_ERR';
  return 'unknown';
}

export function classifyResultSubtype(subtype: string | undefined): string {
  return subtype !== undefined && RESULT_SUBTYPES.has(subtype) ? subtype : UNRECOGNIZED_RESULT;
}

/**
 * Tool names are model- and MCP-declared, so they are attacker-influenced text
 * on a public event. Bound them to printable, non-credential-shaped characters.
 */
function sanitizeToolName(name: string): string {
  const redacted = redact(name).replace(/[^A-Za-z0-9 _.:/[\]-]/gu, '');
  return redacted.trim().slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * Client uuids this frame is stamped with.
 *
 * The SDK stamps `user_message_uuid` on a turn's first reply frame and on its
 * result, and `user_message_uuids` when several submitted messages were
 * coalesced into one turn. Frames in between carry neither, which is why the
 * caller binds a turn on the stamped frame and keeps that binding.
 */
export function correlationStampsOf(message: ClaudeQueryMessage): readonly string[] {
  const stamps: string[] = [];
  const single = asString(message.user_message_uuid);
  if (single !== undefined) stamps.push(single);
  if (Array.isArray(message.user_message_uuids)) {
    for (const entry of message.user_message_uuids) {
      const uuid = asString(entry);
      if (uuid !== undefined && !stamps.includes(uuid)) stamps.push(uuid);
    }
  }
  return stamps;
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
    if (message.error !== undefined && message.error !== null) {
      // The SDK flagged this frame as an error. Its blocks are then the error
      // *body*, not model output — upstream prose that routinely carries a
      // credential, a native id, a path or the prompt — so nothing that came
      // with it is published. Only the classification is, and only from the
      // closed set the SDK declares.
      const reported = asString(message.error);
      const classification = reported !== undefined && ASSISTANT_ERRORS.has(reported) ? reported : 'unknown';
      return [
        {
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: `claude reported an assistant error: ${classification}`,
          },
        },
      ];
    }

    const events: ProviderEventInput[] = [];
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
      const rawName = asString(block.name);
      const name = rawName === undefined ? undefined : sanitizeToolName(rawName);
      const id = asString(block.id);
      if (name === undefined || name === '') continue;
      if (id !== undefined) toolNames.set(id, name);
      // The tool's arguments are deliberately not summarised: they routinely
      // contain file contents and command lines from the workspace.
      events.push({ payload: { type: 'run.tool_activity', toolName: name, phase: 'invoked' } });
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

    // `message.errors` is deliberately not read: it is upstream prose.
    const classification = classifyResultSubtype(subtype);
    return {
      events,
      termination: {
        outcome: 'failed',
        error: agentError('provider_rejected', `claude ended the turn without completing it (${classification})`, {
          providerCode: classification,
        }),
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
