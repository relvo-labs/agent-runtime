// Reference app frontend.
//
// Plain, dependency-free browser JavaScript: no build step, no framework.
// Every piece of caller/model text reaches the DOM through `textContent` or
// `Text.data`, never `innerHTML` — nothing this page ever receives from the
// backend (including a full turn's assistant output) is trusted as markup.

const CSRF_HEADER_NAME = 'x-relvo-reference-app';
const CSRF_HEADER_VALUE = '1';

// Must match `SCRIPTED_FAILURE_TRIGGER_TEXT` in `src/providers/scripted.ts`.
// Duplicated rather than fetched: it is demo-only convenience text, not a
// protocol value, and this keeps the browser shell dependency-free.
const SCRIPTED_FAILURE_TRIGGER_TEXT = 'trigger scripted failure';

const state = {
  sessionId: null,
  providerId: null,
  currentRunId: null,
  currentRunState: null,
  lastConsumedSequence: 0,
  abortController: null,
  assistantNode: null,
  /** key -> { commandId, fingerprint } — see `submitCommand` below. */
  pendingCommands: new Map(),
  /**
   * Bumped every time `startSubscription` opens a new connection — a fresh
   * session, a reconnect, or an overflow-triggered resubscribe are all a new
   * generation. A message parsed from an older connection's response body
   * (already `abort()`-ed, but a frame already buffered before the abort took
   * effect can still finish parsing) is dropped rather than applied: a stale
   * frame must never publish state for whichever session/connection is
   * current now. See `.agents`-external skill `frontend-correctness-review`
   * ("stale requests cannot publish success, error, loading completion,
   * ... state").
   */
  connectionGeneration: 0,
};

const el = {
  providerSelect: document.getElementById('provider-select'),
  openSessionButton: document.getElementById('open-session-button'),
  capabilitySummary: document.getElementById('provider-capability-summary'),
  setupError: document.getElementById('setup-error'),
  sessionPanel: document.getElementById('session-panel'),
  sessionIdBadge: document.getElementById('session-id-badge'),
  sessionStateBadge: document.getElementById('session-state-badge'),
  runStateBadge: document.getElementById('run-state-badge'),
  connectionError: document.getElementById('connection-error'),
  turnInput: document.getElementById('turn-input'),
  sendTurnButton: document.getElementById('send-turn-button'),
  sendFailingTurnButton: document.getElementById('send-failing-turn-button'),
  advanceScriptButton: document.getElementById('advance-script-button'),
  interruptButton: document.getElementById('interrupt-button'),
  closeSessionButton: document.getElementById('close-session-button'),
  disconnectButton: document.getElementById('disconnect-button'),
  reconnectButton: document.getElementById('reconnect-button'),
  transcript: document.getElementById('transcript'),
  inspectorPanel: document.getElementById('inspector-panel'),
  inspectorLog: document.getElementById('inspector-log'),
};

function genCommandId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function showBanner(node, message) {
  if (message === undefined || message === null) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function appendInspectorEntry(label, payload) {
  const item = document.createElement('li');
  const time = new Date().toISOString().slice(11, 23);
  item.textContent = `${time} ${label} ${JSON.stringify(payload)}`;
  el.inspectorLog.appendChild(item);
  el.inspectorLog.scrollTop = el.inspectorLog.scrollHeight;
  el.inspectorPanel.hidden = false;
}

function appendTranscriptLine(text, className) {
  const line = document.createElement('div');
  if (className) line.className = className;
  line.textContent = text;
  el.transcript.appendChild(line);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  return line;
}

function beginAssistantMessage() {
  const line = document.createElement('div');
  line.className = 'assistant-message';
  const node = document.createTextNode('');
  line.appendChild(node);
  el.transcript.appendChild(line);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  state.assistantNode = node;
  return node;
}

function appendAssistantDelta(text) {
  const node = state.assistantNode ?? beginAssistantMessage();
  node.data += text;
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

/**
 * Bare HTTP wrapper. Throws on a genuine transport failure (network error,
 * abort); a well-formed HTTP response of any status is always returned, never
 * thrown, because a 4xx/5xx JSON body is this app answering, not failing to.
 */
async function api(path, options = {}) {
  const headers = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = { error: { code: 'invalid_response', message: 'the server sent a response this page could not parse' } };
  }
  return { status: response.status, body };
}

/**
 * Issues one *command* (open/turn/interrupt/close), preserving the same
 * caller-generated `commandId` across a retry of the *same* payload — an
 * ambiguous transport failure (this function throwing) must be retryable
 * without risking a second effect — while a *changed* payload (different
 * text, different target) always gets a fresh id, because that is a new
 * intent, not a retry of the old one. The id is retired the moment any
 * definite HTTP response comes back (even a rejected receipt): only a
 * genuine network failure leaves it pending for a caller-triggered retry.
 */
async function submitCommand(key, payload, send) {
  const fingerprint = JSON.stringify(payload);
  const existing = state.pendingCommands.get(key);
  const commandId = existing && existing.fingerprint === fingerprint ? existing.commandId : genCommandId(key);
  state.pendingCommands.set(key, { commandId, fingerprint });
  try {
    const result = await send(commandId);
    state.pendingCommands.delete(key);
    return result;
  } catch (error) {
    // Left in place on purpose: a caller-triggered retry of this exact
    // intent will reuse `commandId`. Cleared explicitly by `retry()` below
    // only once the caller gives up.
    throw error;
  }
}

function runIsActive(runState) {
  return (
    runState === 'queued' || runState === 'starting' || runState === 'running' || runState === 'awaiting_interaction'
  );
}

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------

async function loadProviders() {
  const { body } = await api('/api/providers');
  const providers = Array.isArray(body.providers) ? body.providers : [];
  el.providerSelect.textContent = '';
  for (const descriptor of providers) {
    const option = document.createElement('option');
    option.value = String(descriptor.providerId);
    option.textContent = `${String(descriptor.displayName)} (${String(descriptor.providerId)})`;
    el.providerSelect.appendChild(option);
  }
  updateCapabilitySummary(providers[0]);
  el.providerSelect.addEventListener('change', () => {
    updateCapabilitySummary(providers.find((p) => p.providerId === el.providerSelect.value));
  });
}

function updateCapabilitySummary(descriptor) {
  if (descriptor === undefined) {
    el.capabilitySummary.textContent = '';
    return;
  }
  const interrupt = descriptor.run?.interrupt?.mode ?? 'unsupported';
  const streaming = descriptor.run?.streaming ?? {};
  const parts = [
    `interrupt: ${interrupt}`,
    `message deltas: ${streaming.messageDeltas ? 'yes' : 'no'}`,
    `tool activity: ${streaming.toolActivity ? 'yes' : 'no'}`,
    `approval: ${descriptor.interaction?.approval?.supported ? 'yes' : 'no'}`,
    `question: ${descriptor.interaction?.question?.supported ? 'yes' : 'no'}`,
  ];
  el.capabilitySummary.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function resetSessionUi() {
  state.sessionId = null;
  state.providerId = null;
  state.currentRunId = null;
  state.currentRunState = null;
  state.lastConsumedSequence = 0;
  state.assistantNode = null;
  abortCurrentConnection();
  el.sessionPanel.hidden = true;
  el.transcript.textContent = '';
  el.sessionIdBadge.textContent = '—';
  el.sessionStateBadge.textContent = '—';
  el.runStateBadge.hidden = true;
  showBanner(el.connectionError, null);
  el.openSessionButton.disabled = false;
  el.advanceScriptButton.hidden = true;
  el.sendFailingTurnButton.hidden = true;
}

async function openSession() {
  showBanner(el.setupError, null);
  el.openSessionButton.disabled = true;
  try {
    const providerId = el.providerSelect.value;
    const { status, body } = await submitCommand('open', { providerId }, (commandId) =>
      api('/api/sessions', { method: 'POST', body: JSON.stringify({ commandId, providerId }) }),
    );
    if (status === 409) {
      showBanner(el.setupError, body.error?.message ?? 'a session is already open');
      el.openSessionButton.disabled = false;
      return;
    }
    appendInspectorEntry('receipt open_session', body.receipt ?? body);
    const receipt = body.receipt;
    if (receipt === undefined || receipt.disposition === 'rejected') {
      showBanner(el.setupError, receipt?.error?.message ?? body.error?.message ?? 'could not open a session');
      el.openSessionButton.disabled = false;
      return;
    }
    state.sessionId = receipt.result.sessionId;
    state.providerId = providerId;
    el.sessionIdBadge.textContent = state.sessionId;
    el.sessionStateBadge.textContent = 'opening';
    el.sessionPanel.hidden = false;
    // The scripted-demo lane is the only one this app knows how to pace
    // manually or trigger a canned failure on; hiding these for a real
    // provider profile also means nobody accidentally sends a scripted
    // trigger phrase to a billed live provider.
    const isScriptedDemo = providerId === 'scripted-demo';
    el.advanceScriptButton.hidden = !isScriptedDemo;
    el.sendFailingTurnButton.hidden = !isScriptedDemo;
    setSessionControlsEnabled(true);
    startSubscription(state.sessionId, 0);
  } catch {
    showBanner(el.setupError, 'could not reach the server — check your connection and try again');
    el.openSessionButton.disabled = false;
  }
}

function startSubscription(sessionId, fromSequence) {
  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;
  // A fresh generation for THIS connection attempt — a new session, a
  // reconnect of the same session, or an overflow-triggered resubscribe are
  // all a new generation, so anything still in flight from a previous one
  // (already aborted, but possibly mid-parse) is recognisable as stale.
  state.connectionGeneration += 1;
  const generation = state.connectionGeneration;
  void pumpSubscription(sessionId, fromSequence, controller.signal, generation);
}

/** True once a newer connection has superseded `generation`. */
function isStaleConnection(generation) {
  return generation !== state.connectionGeneration;
}

/**
 * Abandons the current connection deliberately (session reset or an
 * explicit Disconnect). Bumps the generation HERE, not only inside the next
 * `startSubscription` call: `AbortController.abort()` cancels the *request*,
 * but bytes the browser already received and buffered internally (a whole
 * batch of trailing SSE frames can arrive over loopback before an abort is
 * even processed) are still delivered to a pending `reader.read()` call
 * afterwards. Without bumping the generation immediately, those trailing
 * frames would still pass the staleness check — they were, after all, from
 * "the current generation" right up until this point — and could publish
 * state for a session that has already been reset or reopened.
 */
function abortCurrentConnection() {
  state.connectionGeneration += 1;
  state.abortController?.abort();
  state.abortController = null;
}

async function pumpSubscription(sessionId, fromSequence, signal, generation) {
  let response;
  try {
    response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/subscribe?fromSequence=${String(fromSequence)}`,
      { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }, signal },
    );
  } catch {
    if (signal.aborted || isStaleConnection(generation)) return;
    showBanner(el.connectionError, 'could not connect to the event stream');
    return;
  }
  if (isStaleConnection(generation)) return; // superseded while the request was in flight
  if (response.status === 404) {
    // The backend no longer knows this session id — most likely it restarted
    // since this page loaded. Reconnect is NOT durable provider resume; be
    // visible about it rather than hanging.
    showBanner(el.setupError, 'this backend no longer recognises the open session (did it restart?) — open a new one.');
    resetSessionUi();
    return;
  }
  if (response.status !== 200 || response.body === null) {
    showBanner(el.connectionError, 'could not open the event stream');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (isStaleConnection(generation)) return; // a newer connection has already taken over
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex;
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const message = JSON.parse(line.slice('data:'.length).trim());
          await handleSubscriptionMessage(message, generation);
          if (isStaleConnection(generation)) return;
        }
      }
    }
  } catch {
    if (!signal.aborted && !isStaleConnection(generation)) {
      showBanner(el.connectionError, 'the event stream disconnected unexpectedly');
    }
  }
}

async function handleSubscriptionMessage(message, generation) {
  if (isStaleConnection(generation)) return; // never let a stale connection publish state
  appendInspectorEntry(message.type, message);
  if (message.type === 'caught_up') {
    state.lastConsumedSequence = message.sequence;
    return;
  }
  if (message.type === 'overflow') {
    await backfillAfterOverflow(message, generation);
    return;
  }
  if (message.type === 'closed') {
    el.sessionStateBadge.textContent = message.reason === 'session_failed' ? 'failed' : 'closed';
    setSessionControlsEnabled(false);
    return;
  }
  // message.type === 'event'
  applyEvent(message.event);
}

/** Renders one real event. Shared by live delivery and overflow backfill. */
function applyEvent(event) {
  state.lastConsumedSequence = Math.max(state.lastConsumedSequence, event.sequence);
  const payload = event.payload;
  switch (payload.type) {
    case 'session.opened':
      // The runtime never emits a separate `session.state_changed` for this
      // transition — `session.opened` itself is documented to mark the
      // session ready (see `packages/runtime/src/projection.ts`), so this is
      // the one and only signal the session left `opening`.
      el.sessionStateBadge.textContent = 'ready';
      break;
    case 'session.state_changed':
      el.sessionStateBadge.textContent = payload.to;
      break;
    case 'turn.started':
      appendTranscriptLine(
        `You: ${payload.input.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')}`,
        'user-message',
      );
      state.assistantNode = null;
      break;
    case 'run.started':
      // Likewise, a run's initial `running` state arrives only on this
      // event — there is no companion `run.state_changed` for it. Missing
      // this case is exactly what left the run badge empty and Interrupt
      // permanently disabled even though the run was genuinely running.
      state.currentRunState = 'running';
      el.runStateBadge.hidden = false;
      el.runStateBadge.textContent = 'running';
      el.interruptButton.disabled = false;
      break;
    case 'run.state_changed':
      state.currentRunState = payload.to;
      el.runStateBadge.hidden = false;
      el.runStateBadge.textContent = payload.to;
      el.interruptButton.disabled = !runIsActive(payload.to);
      break;
    case 'run.message_delta':
      appendAssistantDelta(payload.text);
      break;
    case 'run.tool_activity':
      appendTranscriptLine(`[tool] ${payload.toolName} — ${payload.phase}`, 'tool-activity');
      break;
    case 'run.finished':
      state.assistantNode = null;
      // The run's terminal outcome (`succeeded`/`failed`/`interrupted`) IS a
      // real run state — show it, not just leave the last transient value
      // (or nothing at all) on the badge.
      state.currentRunState = payload.termination.outcome;
      el.runStateBadge.hidden = false;
      el.runStateBadge.textContent = payload.termination.outcome;
      el.interruptButton.disabled = true;
      if (payload.termination.outcome !== 'succeeded') {
        appendTranscriptLine(
          `[run ${payload.termination.outcome}${payload.termination.error ? `: ${payload.termination.error.message}` : ''}]`,
          'diagnostic',
        );
      }
      break;
    case 'diagnostic':
      appendTranscriptLine(`[${payload.level}] ${payload.message}`, 'diagnostic');
      break;
    default:
      break;
  }
  if (event.runId) state.currentRunId = event.runId;
}

/**
 * An `overflow` message means this stream fell behind and ended (the default
 * policy). Nothing was lost server-side — the durable log still has every
 * event — so this backfills exactly the missed range via `readEvents`, then
 * reopens the subscription from where the backfill left off. No duplicated
 * transcript: the backfilled range starts exactly at `droppedFromSequence`
 * and nothing already rendered live is re-applied.
 */
async function backfillAfterOverflow(overflow, generation) {
  const sessionId = state.sessionId;
  showBanner(
    el.connectionError,
    `this subscription fell behind and lost ${String(overflow.undeliveredCount)} event(s) on the wire ` +
      '(nothing was lost server-side) — backfilling now…',
  );
  const { body } = await api(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?fromSequence=${String(overflow.droppedFromSequence - 1)}`,
  );
  // The session may have been closed (or a newer connection already opened)
  // while the backfill request was in flight — never apply a stale batch or
  // reconnect on behalf of a connection nothing still refers to.
  if (isStaleConnection(generation) || state.sessionId !== sessionId) return;
  for (const event of body.page?.events ?? []) applyEvent(event);
  showBanner(el.connectionError, null);
  startSubscription(sessionId, state.lastConsumedSequence);
}

function setSessionControlsEnabled(enabled) {
  el.sendTurnButton.disabled = !enabled;
  el.sendFailingTurnButton.disabled = !enabled;
  el.turnInput.disabled = !enabled;
  el.closeSessionButton.disabled = !enabled;
  el.disconnectButton.disabled = !enabled;
  el.reconnectButton.disabled = enabled; // reconnect only makes sense once disconnected
  if (!enabled) el.interruptButton.disabled = true;
}

async function sendTurnText(text) {
  if (text.length === 0 || state.sessionId === null) return;
  const sessionId = state.sessionId;
  try {
    const { body } = await submitCommand('turn', { sessionId, text }, (commandId) =>
      api(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ commandId, text }),
      }),
    );
    appendInspectorEntry('receipt submit_turn', body.receipt ?? body);
    // The session may have been closed (and possibly a new one opened)
    // while this request was in flight — never let a stale response clear
    // the input box or publish a banner/run id for whatever session is
    // current now.
    if (state.sessionId !== sessionId) return;
    const receipt = body.receipt;
    if (receipt?.disposition === 'rejected') {
      showBanner(el.connectionError, receipt.error?.message ?? 'the turn was rejected');
      return;
    }
    showBanner(el.connectionError, null);
    el.turnInput.value = '';
    if (receipt?.result?.runId) state.currentRunId = receipt.result.runId;
  } catch {
    if (state.sessionId !== sessionId) return;
    showBanner(el.connectionError, 'could not reach the server — the message was not sent. Try again.');
  }
}

async function sendTurn() {
  await sendTurnText(el.turnInput.value.trim());
}

async function sendFailingTurn() {
  await sendTurnText(SCRIPTED_FAILURE_TRIGGER_TEXT);
}

async function advanceScript() {
  if (state.sessionId === null) return;
  const sessionId = state.sessionId;
  const { body } = await api(`/api/sessions/${encodeURIComponent(sessionId)}/advance-script`, { method: 'POST' });
  if (state.sessionId !== sessionId) return; // superseded while this request was in flight
  appendInspectorEntry('advance-script', body.snapshot ?? body);
}

async function interruptRun() {
  if (state.sessionId === null || state.currentRunId === null) return;
  const sessionId = state.sessionId;
  const runId = state.currentRunId;
  try {
    const { body } = await submitCommand('interrupt', { sessionId, runId }, (commandId) =>
      api(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/interrupt`, {
        method: 'POST',
        body: JSON.stringify({ commandId }),
      }),
    );
    if (state.sessionId !== sessionId) return;
    appendInspectorEntry('receipt interrupt_run', body.receipt ?? body);
  } catch {
    if (state.sessionId !== sessionId) return;
    showBanner(el.connectionError, 'could not reach the server — interrupt may not have been delivered. Try again.');
  }
}

async function closeSession() {
  if (state.sessionId === null) return;
  const sessionId = state.sessionId;
  try {
    const { status, body } = await submitCommand('close', { sessionId }, (commandId) =>
      api(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        body: JSON.stringify({ commandId }),
      }),
    );
    if (status === 503) {
      // A retryable cleanup failure. `closeSession` rejects its *promise*
      // rather than persisting a receipt exactly for this case (see
      // `callRuntimeCommand` in `src/http/routes.ts`), so no commandId was
      // ever recorded server-side either way; a fresh click (a new
      // commandId, already the case since `submitCommand` clears its own
      // record on any definite HTTP answer, including this one) retries the
      // same close cleanly.
      appendInspectorEntry('close_session error', body.error ?? body);
      showBanner(el.connectionError, `close failed and can be retried: ${body.error?.message ?? 'unknown error'}`);
      return;
    }
    appendInspectorEntry('receipt close_session', body.receipt ?? body);
    setSessionControlsEnabled(false);
    resetSessionUi();
  } catch {
    showBanner(el.connectionError, 'could not reach the server — close may not have completed. Try again.');
  }
}

function disconnectStream() {
  abortCurrentConnection();
  el.disconnectButton.disabled = true;
  el.reconnectButton.disabled = false;
  showBanner(
    el.connectionError,
    'disconnected from the event stream (the run itself is unaffected — reconnect any time).',
  );
}

function reconnectStream() {
  if (state.sessionId === null) return;
  showBanner(el.connectionError, null);
  el.disconnectButton.disabled = false;
  el.reconnectButton.disabled = true;
  startSubscription(state.sessionId, state.lastConsumedSequence);
}

window.addEventListener('beforeunload', () => state.abortController?.abort());

el.openSessionButton.addEventListener('click', () => void openSession());
el.sendTurnButton.addEventListener('click', () => void sendTurn());
el.sendFailingTurnButton.addEventListener('click', () => void sendFailingTurn());
el.advanceScriptButton.addEventListener('click', () => void advanceScript());
el.interruptButton.addEventListener('click', () => void interruptRun());
el.closeSessionButton.addEventListener('click', () => void closeSession());
el.disconnectButton.addEventListener('click', disconnectStream);
el.reconnectButton.addEventListener('click', reconnectStream);
el.turnInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void sendTurn();
  }
});

setSessionControlsEnabled(false);
void loadProviders();
