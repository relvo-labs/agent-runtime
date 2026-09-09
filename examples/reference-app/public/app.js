// Reference app frontend.
//
// Plain, dependency-free browser JavaScript: no build step, no framework.
// Every piece of caller/model text reaches the DOM through `textContent` or
// `Text.data`, never `innerHTML` — nothing this page ever receives from the
// backend (including a full turn's assistant output) is trusted as markup.

const CSRF_HEADER_NAME = 'x-relvo-reference-app';
const CSRF_HEADER_VALUE = '1';

/** @type {{ sessionId: string | null, currentRunId: string | null, abortController: AbortController | null, assistantNode: Text | null }} */
const state = {
  sessionId: null,
  currentRunId: null,
  abortController: null,
  assistantNode: null,
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
  interruptButton: document.getElementById('interrupt-button'),
  closeSessionButton: document.getElementById('close-session-button'),
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

async function openSession() {
  showBanner(el.setupError, null);
  el.openSessionButton.disabled = true;
  try {
    const commandId = genCommandId('open');
    const providerId = el.providerSelect.value;
    const { body } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ commandId, providerId }),
    });
    appendInspectorEntry('receipt open_session', body.receipt ?? body);
    const receipt = body.receipt;
    if (receipt === undefined || receipt.disposition === 'rejected') {
      showBanner(el.setupError, receipt?.error?.message ?? body.error?.message ?? 'could not open a session');
      return;
    }
    state.sessionId = receipt.result.sessionId;
    el.sessionIdBadge.textContent = state.sessionId;
    el.sessionStateBadge.textContent = 'opening';
    el.sessionPanel.hidden = false;
    startSubscription(state.sessionId);
  } finally {
    el.openSessionButton.disabled = false;
  }
}

function startSubscription(sessionId) {
  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;
  void pumpSubscription(sessionId, controller.signal);
}

async function pumpSubscription(sessionId, signal) {
  let response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subscribe?fromSequence=0`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    showBanner(el.connectionError, 'could not connect to the event stream');
    return;
  }
  if (response.body === null) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex;
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const message = JSON.parse(line.slice('data:'.length).trim());
          handleSubscriptionMessage(message);
        }
      }
    }
  } catch {
    if (!signal.aborted) showBanner(el.connectionError, 'the event stream disconnected unexpectedly');
  }
}

function handleSubscriptionMessage(message) {
  appendInspectorEntry(message.type, message);
  if (message.type === 'caught_up') return;
  if (message.type === 'overflow') {
    showBanner(
      el.connectionError,
      `this subscription fell behind and lost ${String(message.undeliveredCount)} event(s) on the wire ` +
        '(nothing was lost server-side — reopen the session to resume from the durable log).',
    );
    return;
  }
  if (message.type === 'closed') {
    el.sessionStateBadge.textContent = message.reason === 'session_failed' ? 'failed' : 'closed';
    setSessionControlsEnabled(false);
    return;
  }
  // message.type === 'event'
  const payload = message.event.payload;
  switch (payload.type) {
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
    case 'run.state_changed':
      el.runStateBadge.hidden = false;
      el.runStateBadge.textContent = payload.to;
      el.interruptButton.disabled = !runIsActive(payload.to);
      if (payload.to === 'running' || payload.to === 'starting')
        state.currentRunId = message.event.runId ?? state.currentRunId;
      break;
    case 'run.message_delta':
      appendAssistantDelta(payload.text);
      break;
    case 'run.tool_activity':
      appendTranscriptLine(`[tool] ${payload.toolName} — ${payload.phase}`, 'tool-activity');
      break;
    case 'run.finished':
      state.assistantNode = null;
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
  if (message.event.runId) state.currentRunId = message.event.runId;
}

function setSessionControlsEnabled(enabled) {
  el.sendTurnButton.disabled = !enabled;
  el.turnInput.disabled = !enabled;
  el.closeSessionButton.disabled = !enabled;
  if (!enabled) el.interruptButton.disabled = true;
}

async function sendTurn() {
  const text = el.turnInput.value.trim();
  if (text.length === 0 || state.sessionId === null) return;
  const commandId = genCommandId('turn');
  const { body } = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/turns`, {
    method: 'POST',
    body: JSON.stringify({ commandId, text }),
  });
  appendInspectorEntry('receipt submit_turn', body.receipt ?? body);
  const receipt = body.receipt;
  if (receipt?.disposition === 'rejected') {
    showBanner(el.connectionError, receipt.error?.message ?? 'the turn was rejected');
    return;
  }
  showBanner(el.connectionError, null);
  el.turnInput.value = '';
  if (receipt?.result?.runId) state.currentRunId = receipt.result.runId;
}

async function interruptRun() {
  if (state.sessionId === null || state.currentRunId === null) return;
  const commandId = genCommandId('interrupt');
  const { body } = await api(
    `/api/sessions/${encodeURIComponent(state.sessionId)}/runs/${encodeURIComponent(state.currentRunId)}/interrupt`,
    { method: 'POST', body: JSON.stringify({ commandId }) },
  );
  appendInspectorEntry('receipt interrupt_run', body.receipt ?? body);
}

async function closeSession() {
  if (state.sessionId === null) return;
  const commandId = genCommandId('close');
  const { body } = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/close`, {
    method: 'POST',
    body: JSON.stringify({ commandId }),
  });
  appendInspectorEntry('receipt close_session', body.receipt ?? body);
  setSessionControlsEnabled(false);
}

window.addEventListener('beforeunload', () => state.abortController?.abort());

el.openSessionButton.addEventListener('click', () => void openSession());
el.sendTurnButton.addEventListener('click', () => void sendTurn());
el.interruptButton.addEventListener('click', () => void interruptRun());
el.closeSessionButton.addEventListener('click', () => void closeSession());
el.turnInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void sendTurn();
  }
});

void loadProviders();
