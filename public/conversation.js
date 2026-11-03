const $ = id => document.getElementById(id);
let current = null, busy = false, controlBusy = false, modelSession = null, generationEnabled = false, accessState = null, budgetState = null, createEvent = crypto.randomUUID(), replyEvent = crypto.randomUUID();
let preparedEmails = [], preparedEmail = null, exampleIndex = 0, conversations = [], viewingHistory = false, viewingAttention = false, historyFilter = 'all', historyDate = 'today', replyFor = null;
const examples = [
  { name: 'Maya', label: 'Timesheet saving', subject: 'Does my time save automatically?', body: "Hi, I've entered four hours against the Riverside Café website project. Does this save automatically, or do I need to save it myself?" },
  { name: 'Mia', label: 'Create a job', subject: 'How do I create a job for a client?', body: "Hi, I'm Mia. We have an existing client and I need to create a new job. Where do I start and what basic information should I enter?" },
  { name: 'Liam', label: 'Job access', subject: 'I cannot view the job I need', body: "Hi, I'm Liam. I need to record time, but I don't have permission to view the required job. Who should help with this access issue?" },
  { name: 'Ava', label: 'Saving error', subject: 'Weekly timesheet returns an error', body: "Hi, I'm Ava. I click Save in the weekly timesheet view, but it returns HTTP 500 every time and my entries disappear. Please help investigate this repeated error." }
];
const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
function sourceLinkedText(tag, text, sources) {
  const node = el(tag, '');
  const allowed = new Set((sources || []).map(source => source.url).filter(url => typeof url === 'string' && url.startsWith('https://')));
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>\])]+/g)) {
    const url = match[0].replace(/[.,;]$/, '');
    if (!allowed.has(url)) continue;
    node.append(el('span', text.slice(cursor, match.index)));
    const link = el('a', url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    node.append(link); cursor = match.index + url.length;
  }
  node.append(el('span', text.slice(cursor)));
  return node;
}
async function api(path, value) {
  if (window.supportConversationApi) return window.supportConversationApi(path, value);
  const response = await fetch(location.pathname === '/live' ? path.replace('/api/','/api/live/') : path, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || 'Request failed. Refresh saved state before trying again.'); error.code = data.error?.code; error.access = data.access; throw error; }
  return data;
}
const statusLabels = { model_paused: 'Paused · saved model step', sent_test: 'Completed · test outbox', human_required: 'Needs human review', awaiting_reply: 'Waiting for customer reply', awaiting_review: 'Ready for support review', approved: 'Approved · ready for test outbox', rejected: 'Rejected · not sent', delivery_failed: 'Test delivery failed', delivery_unknown: 'Test delivery needs checking', processing: 'Reviewing the email', sending: 'Sending to test outbox' };
const attentionStatuses = new Set(['human_required', 'rejected', 'delivery_failed', 'delivery_unknown']);
const modeLabels = { live_ai: 'Live AI mode', rules_rehearsal: 'Rules rehearsal · no live AI', not_connected: 'Model unavailable', test_mock: 'Mock test' };
const emptyEvidence = 'No evidence yet. Articles appear after the email and any needed clarification are checked. Open a completed record to see its sources.';
function resetReview() {
  $('reviewerV2').value = 'Omar (fictional reviewer)'; $('noteV2').value = ''; $('confirmV2').checked = false; replyFor = null;
}
function openPrepared(email) {
  current = null; preparedEmail = email; exampleIndex = email.index; viewingHistory = false; createEvent = email.id; replyEvent = crypto.randomUUID();
  $('subjectV2').value = email.subject; $('bodyV2').value = email.body; $('error').hidden = true;
  resetReview(); render();
}
function prepareExample(index) {
  exampleIndex = index;
  const email = { ...examples[index], index, id: crypto.randomUUID() };
  preparedEmails.push(email); openPrepared(email);
}
function recordButton(record) {
  const button = el('button', '');
  button.append(el('strong', record.subject), el('span', statusLabels[record.status] || record.status.replaceAll('_', ' ')), el('span', modeLabels[record.mode] || record.mode || 'New email'));
  if (record.created_at && Number.isFinite(Date.parse(record.created_at))) button.append(el('span', new Date(record.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })));
  button.className = 'sample-item'; button.disabled = busy; button.setAttribute('aria-current', String(current?.id === record.id));
  button.addEventListener('click', () => { current = record; preparedEmail = null; viewingHistory = false; resetReview(); render(); $('conversationHeading').focus?.(); });
  return button;
}
function renderLists() {
  $('workspaceView').hidden = viewingHistory; $('historyView').hidden = !viewingHistory; $('nextStep').hidden = viewingHistory;
  const attention = conversations.filter(record => attentionStatuses.has(record.status));
  $('viewAttention').textContent = `View queue (${attention.length})`;
  $('attentionSummary').textContent = attention.length ? `${attention.length} saved conversation${attention.length === 1 ? '' : 's'} to inspect across all dates.` : 'No escalated cases, rejected drafts or test-delivery problems.';
  $('historyTitle').textContent = viewingAttention ? 'Needs human attention' : 'Conversation history';
  $('historyDescription').textContent = viewingAttention ? 'Escalated cases, rejected drafts and test-delivery problems across all dates. Rejecting a draft does not resolve the customer’s issue. Open a case to inspect its reason; department assignment and follow-up tracking are planned, not connected in this demo.' : 'Today’s submitted conversations, including work in progress and completed test deliveries. Earlier test runs are kept in Archived records.';
  $('historyDateFilters').hidden = viewingAttention; $('historyStatusFilters').hidden = viewingAttention;
  const day = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' }) : null;
  const today = day(new Date().toISOString());
  const isToday = record => day(record.created_at) === today;
  $('viewHistory').textContent = `View history (${conversations.filter(isToday).length} today)`;
  $('historyDateLabel').textContent = viewingAttention ? 'All dates · saved records · no model call to view' : historyDate === 'today' ? `Today · ${today} · Melbourne` : 'Archived records · other dates';
  $('preparedList').replaceChildren(...preparedEmails.map(email => {
    const button = el('button', ''); button.className = 'sample-item'; button.disabled = busy;
    button.setAttribute('aria-current', String(!current && preparedEmail?.id === email.id));
    button.append(el('strong', `${email.name} · ${email.label}`), el('span', email.subject), el('span', 'New email · not submitted'));
    button.addEventListener('click', () => { openPrepared(email); $('subjectV2').focus?.(); }); return button;
  }));
  $('emptyInbox').hidden = preparedEmails.length > 0;
  $('exampleLabel').textContent = !current && preparedEmail ? `${preparedEmail.name} · ${preparedEmail.label} · Example ${preparedEmail.index + 1} of ${examples.length}` : 'Saved conversation';
  const finished = record => ['sent_test', 'rejected'].includes(record.status);
  const records = viewingAttention ? attention : conversations.filter(record => historyDate === 'today' ? isToday(record) : !isToday(record)).filter(record => historyFilter === 'all' || (historyFilter === 'rejected' ? record.status === 'rejected' : historyFilter === 'finished' ? finished(record) : !finished(record)));
  $('cases').replaceChildren(...records.map(recordButton));
  $('emptyHistory').hidden = records.length > 0;
  $('emptyHistory').textContent = viewingAttention ? 'No conversations need human attention in this queue.' : 'No conversations in this view.';
  for (const filter of ['all', 'ongoing', 'finished', 'rejected']) $(`history-${filter}`).setAttribute('aria-pressed', String(historyFilter === filter));
  for (const date of ['today', 'archive']) $(`history-${date}`).setAttribute('aria-pressed', String(historyDate === date));
}
function updateApprovalAvailability() {
  const reviewable = current && ['awaiting_review', 'human_required'].includes(current.status);
  $('approveV2').disabled = busy || !reviewable || !$('confirmV2').checked || !$('draftV2').value.trim();
}
function showNextStep() {
  const needsAccess = location.pathname === '/live' && ['signed_out', 'not_authorized'].includes(accessState);
  const unknownAccess = location.pathname === '/live' && accessState === null;
  let startHint;
  if (busy) startHint = 'Please wait while this conversation is processed.';
  else if (unknownAccess) startHint = 'Workspace status could not be checked. Refresh to try again.';
  else if (needsAccess) startHint = 'Sign in with the owner account to view this workspace.';
  else if (!generationEnabled && modelSession?.manual_control) startHint = modelSession.stop_reason;
  else if (!generationEnabled && budgetState === 'unavailable') startHint = 'Model testing is unavailable. You can still open saved records in View history.';
  else if (!generationEnabled) startHint = 'This test has ended. Open a Completed · test outbox record in View history. Starting a new test needs a new, limited authorization.';
  else if (current) startHint = 'You are viewing a saved conversation. New example prepares a different synthetic email.';
  else startHint = 'Start conversation submits this example and moves it to history. TEST outbox only; no real email.';
  $('startHint').textContent = startHint;
  let next;
  if (busy) next = 'Working on the current step. Please wait.';
  else if (!current) {
    if (unknownAccess) next = 'Next: refresh saved state to check workspace access. No model call was made.';
    else if (needsAccess) next = 'Next: sign in to view saved owner records, or use public rules rehearsal.';
    else if (!generationEnabled && modelSession?.manual_control && modelSession.can_enable) next = 'Next: turn Model ON above, then submit a synthetic email. Saved records can be reviewed with the model OFF.';
    else if (!generationEnabled) next = 'Next: open Completed · test outbox in View history. Follow its messages, evidence and saved test result without making model calls.';
    else next = 'Next: submit the selected sample email below. New example prepares a different customer and scenario.';
  } else {
    const steps = {
      model_paused: generationEnabled ? 'Next: select Resume saved model step. Completed model steps will not be repeated.' : 'Model work is paused. Turn Model ON within the remaining session allowance, then explicitly resume the saved step.',
      sent_test: 'Completed: follow the messages below, check the evidence on the right, and open Test outbox for the saved result. No real email was sent.',
      awaiting_reply: generationEnabled ? 'Next: act as the customer. Read the clarification, enter a reply below, then select Receive reply.' : modelSession?.manual_control && modelSession.can_enable ? 'A customer reply is needed. Turn Model ON within the remaining session allowance, then submit the reply.' : 'A customer reply is needed, but this model test has ended. You can inspect the saved conversation; continuing needs a new limited authorization.',
      awaiting_review: 'Next: act as support. Check the evidence, edit the draft if needed, then explicitly approve this exact version.',
      approved: 'Next: send the saved approved version to the TEST outbox. No real email is sent.',
      human_required: 'A person needs to handle this case. Read the reason below; no answer has been approved.',
      rejected: 'This draft was rejected and was not sent. Read the review record below. This saved decision is closed; opening it does not restart processing.',
      delivery_unknown: 'Next: check the existing test-delivery result before considering another send.',
      delivery_failed: 'Next: check the existing test-delivery result before considering another send.'
    };
    next = steps[current.status] || 'Read the saved decision and conversation below. No new model call is needed to view it.';
  }
  $('nextStep').textContent = next;
}
function renderModelControls() {
  $('modelControls').hidden = !modelSession?.manual_control;
  const on = modelSession?.model_on === true;
  $('modelToggle').textContent = on ? 'Model ON · Turn off' : 'Model OFF · Turn on';
  $('modelToggle').setAttribute('aria-checked', String(on));
  $('modelToggle').disabled = controlBusy || !modelSession?.manual_control || (!on && !modelSession?.can_enable);
  if (modelSession?.manual_control) {
    const expiry = modelSession.expires_at ? new Date(modelSession.expires_at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' Melbourne' : 'no active authorization';
    $('modelSessionState').textContent = `Model ${on ? 'ON' : 'OFF'} · Used ${modelSession.requests_reserved} of ${modelSession.max_requests} requests · ${modelSession.remaining_requests} requests left · Ends ${expiry} · Budget US$${Number(modelSession.max_usd || 0).toFixed(2)}`;
    $('modelSessionReason').textContent = modelSession.stop_reason;
  }
}
function render({ preserveReview = false } = {}) {
  $('conversationPanel').hidden = !current;
  $('subjectV2').disabled = !!current || busy; $('bodyV2').disabled = !!current || busy;
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  $('start').disabled = busy || !!current || !generationEnabled;
  $('reply').disabled = busy || !generationEnabled;
  $('resumeV2').disabled = busy || !generationEnabled;
  renderModelControls();
  updateApprovalAvailability();
  showNextStep();
  renderLists();
  if (!current) { $('resumeV2').hidden = true; $('status').textContent = 'New email'; $('sourcesV2').replaceChildren(el('p', emptyEvidence)); return; }
  $('status').textContent = statusLabels[current.status] || current.status.replaceAll('_', ' ');
  $('subjectV2').value = current.subject; $('bodyV2').value = current.messages[0].text;
  $('reason').textContent = current.reason || '';
  $('messages').replaceChildren(...current.messages.map(m => {
    const text = `${m.role === 'customer' ? 'Synthetic customer' : 'Support / test transport'}: ${m.text}`;
    return m.role === 'assistant' ? sourceLinkedText('li', text, current.sources) : el('li', text);
  }));
  $('resumeV2').hidden = current.status !== 'model_paused';
  $('replyBox').hidden = current.status !== 'awaiting_reply';
  if (current.status === 'awaiting_reply' && replyFor !== `${current.id}:${current.turn}`) {
    $('replyV2').value = current.messages.at(-1)?.text === 'Are you using the weekly timesheet view, quick time entry, or another screen?' ? "I'm using the weekly timesheet view." : '';
    replyFor = `${current.id}:${current.turn}`;
  }
  $('reviewBox').hidden = !['awaiting_review', 'human_required'].includes(current.status);
  if (!preserveReview) { $('draftV2').value = current.draft || ''; $('confirmV2').checked = false; }
  updateApprovalAvailability();
  $('noteV2').placeholder = current.status === 'human_required' ? 'Required: explain your manual response and handoff decision.' : 'What did you verify or edit?';
  $('sendBox').hidden = current.status !== 'approved';
  $('reconcileV2').hidden = !['delivery_unknown', 'delivery_failed'].includes(current.status);
  $('resultV2').textContent = current.status === 'sent_test' ? 'Accepted by the durable test outbox. No real email was sent; this does not prove customer receipt or resolution.' : current.status === 'delivery_unknown' ? 'Delivery is unknown. Check the existing result before any resend; automatic resend is blocked.' : current.status === 'delivery_failed' ? 'Test delivery failed. It is not marked sent. Inspect the result with a person.' : current.status === 'rejected' ? 'Rejected · not sent. This saved decision is read-only. The reason and reviewer record are available in Model attempts, overrides & provenance below.' : '';
  $('sourcesV2').replaceChildren(...(current.sources || []).map(source => { const card = el('article', ''); const link = el('a', `${source.id} · ${source.title}`); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link, ...[...source.facts, ...source.conditions].map(text => el('p', text))); return card; }));
  $('outbox').replaceChildren(...current.deliveries.map(d => { const card = el('article', ''); card.append(el('h3', `${d.kind === 'answer' ? 'Approved answer' : 'Clarification'} · ${statusLabels[d.status] || d.status} · TEST ONLY`), sourceLinkedText('p', d.body, current.sources), el('p', `Receipt: ${d.receipt || 'none'} · version hash ${d.hash}`)); return card; }));
  if (!current.sources?.length) $('sourcesV2').append(el('p', 'No source evidence was selected for this case. Read its next step and reason.'));
  $('auditV2').textContent = JSON.stringify({ status: current.status, mode: current.mode, model: current.model, revision: current.revision, attempts: current.attempts, overrides: current.overrides, provenance: current.provenance, approval: current.approval, reviews: current.review_history }, null, 2);
}
function showAccess(access) {
  accessState = access?.status || null;
  const livePage = location.pathname === '/live';
  $('accessStatus').hidden = !livePage;
  $('signInV2').hidden = !livePage || !['signed_out', 'not_authorized'].includes(access?.status);
  $('signInV2').textContent = access?.status === 'not_authorized' ? 'Choose the owner account with ChatGPT' : 'Sign in with ChatGPT for the owner workspace';
  $('accessStatus').textContent = access?.status === 'signed_in' ? 'Signed in as the workspace owner.' : access?.status === 'signed_out' ? 'You are not signed in to this workspace.' : access?.status === 'not_authorized' ? 'You are signed in, but this account cannot access the owner workspace.' : 'Checking your sign-in…';
}
function showUnavailable(error) {
  generationEnabled = false;
  if (error.access) showAccess(error.access);
  else if (location.pathname === '/live' && $('accessStatus').textContent === 'Checking your sign-in…') $('accessStatus').textContent = 'Your sign-in could not be checked. Refresh to try again.';
  $('mode').textContent = error.access?.status === 'signed_out' ? 'Sign in to view saved owner records. No model call was made.' : error.access?.status === 'not_authorized' ? 'Owner access is required. Public rules rehearsal is still available.' : 'Saved records could not be loaded. Refresh to try again; no model call was made.';
  $('error').textContent = error.message; $('error').hidden = false;
}
async function refresh() {
  const data = await api('/api/conversations');
  $('cloudLiveNav').hidden = !data.cloud;
  showAccess(data.access);
  generationEnabled = data.generation_enabled === true;
  budgetState = data.budget?.status;
  modelSession = data.budget;
  if (data.access?.status === 'signed_in' && modelSession?.manual_control) {
    $('mode').textContent = generationEnabled ? 'Model is ON for this limited session. You can run multiple synthetic cases within the shared request and cost limits; idle pages make no model calls.' : modelSession.stop_reason;
  } else if (data.access?.status === 'signed_in' && !generationEnabled) {
    $('mode').textContent = data.budget?.status === 'unavailable' ? 'Model testing is currently unavailable. You can still view saved records. TEST outbox only; no real email.' : 'This model test has ended. You can view saved records. Starting a new test needs a new, limited authorization. TEST outbox only; no real email.';
  } else {
    $('mode').textContent = !generationEnabled ? 'Model generation is disabled in this session. You can view saved records without making model calls.' : data.mode === 'live_ai' ? `LIVE MODEL · ${data.model} · paid requests are bounded by the approved test budget. Synthetic events and TEST outbox only; no real email.` : 'RULES REHEARSAL · NO LIVE AI · deterministic workflow demonstration. Test deliveries only; these results do not measure model quality.';
    if (data.budget?.status === 'ready') $('mode').textContent += ` Remaining approved requests: ${data.budget.remaining_requests}.`;
  }
  conversations = data.conversations;
  if (current) current = data.conversations.find(r => r.id === current.id) || current;
}
async function action(fn) {
  if (busy) return; busy = true; $('error').hidden = true; render();
  try { current = await fn(); await refresh(); }
  catch (error) { if (error.access && error.access.status !== 'signed_in') showUnavailable(error); else { $('error').textContent = error.message; $('error').hidden = false; } }
  finally { busy = false; render(); }
}
$('start').addEventListener('click', () => {
  const value = { subject: $('subjectV2').value, body: $('bodyV2').value, synthetic: true, event_id: createEvent };
  const preparedId = preparedEmail?.id;
  return action(async () => {
    const result = await api('/api/conversations', value);
    preparedEmails = preparedEmails.filter(email => email.id !== preparedId); preparedEmail = null;
    return result;
  });
});
$('reply').addEventListener('click', () => { const value = { body: $('replyV2').value, synthetic: true, event_id: replyEvent, expected_revision: current.revision }; action(async () => { const result = await api(`/api/conversations/${current.id}/reply`, value); replyEvent = crypto.randomUUID(); return result; }); });
for (const [button, decision] of [['saveV2', 'save'], ['rejectV2', 'reject'], ['approveV2', 'approve']]) $(button).addEventListener('click', () => {
  const value = { expected_revision: current.revision, action: decision, draft: $('draftV2').value, reviewer: $('reviewerV2').value, note: $('noteV2').value, confirmed: $('confirmV2').checked };
  action(() => api(`/api/conversations/${current.id}/review`, value));
});
$('modelToggle').addEventListener('click', async () => {
  if (controlBusy || !modelSession?.manual_control) return;
  const value = { enabled: !modelSession.model_on, expected_version: modelSession.control_version };
  const viewedId = current?.id, viewedRevision = current?.revision;
  controlBusy = true; $('error').hidden = true; renderModelControls();
  try { await api('/api/model-session', value); await refresh(); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; await refresh().catch(() => {}); }
  finally { controlBusy = false; render({ preserveReview: current?.id === viewedId && current?.revision === viewedRevision }); }
});
$('resumeV2').addEventListener('click', () => action(() => api(`/api/conversations/${current.id}/resume`, { expected_revision: current.revision })));
$('confirmV2').addEventListener('change', updateApprovalAvailability);
$('draftV2').addEventListener('input', () => { $('confirmV2').checked = false; updateApprovalAvailability(); });
$('sendV2').addEventListener('click', () => action(() => api(`/api/conversations/${current.id}/send`, { expected_revision: current.revision, approved_hash: current.approval.hash })));
$('reconcileV2').addEventListener('click', () => action(() => api(`/api/conversations/${current.id}/reconcile`, { expected_revision: current.revision })));
$('refresh').addEventListener('click', () => action(async () => { await refresh(); return current; }));
$('new').addEventListener('click', () => { prepareExample((exampleIndex + 1) % examples.length); $('subjectV2').focus?.(); });
for (const field of ['subjectV2', 'bodyV2']) $(field).addEventListener('input', () => {
  if (!current && preparedEmail) { preparedEmail.subject = $('subjectV2').value; preparedEmail.body = $('bodyV2').value; renderLists(); }
});
$('viewHistory').addEventListener('click', () => { viewingHistory = true; viewingAttention = false; historyDate = 'today'; renderLists(); $('backToInbox').focus?.(); });
$('viewAttention').addEventListener('click', () => { viewingHistory = true; viewingAttention = true; renderLists(); $('backToInbox').focus?.(); });
$('backToInbox').addEventListener('click', () => { viewingHistory = false; renderLists(); $(viewingAttention ? 'viewAttention' : 'viewHistory').focus?.(); });
for (const filter of ['all', 'ongoing', 'finished', 'rejected']) $(`history-${filter}`).addEventListener('click', () => { historyFilter = filter; renderLists(); });
for (const date of ['today', 'archive']) $(`history-${date}`).addEventListener('click', () => { historyDate = date; renderLists(); });
prepareExample(0);
showAccess();
refresh().then(render).catch(error => { showUnavailable(error); render(); });
