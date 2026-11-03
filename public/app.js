const $ = id => document.getElementById(id);
const state = { bootstrap: null, selected: null, run: null, busy: false, dirty: false, view: 'knowledge' };
const labels = { how_to: 'How-to', bug_report: 'Possible bug', complaint: 'Complaint', churn_signal: 'Churn signal', permission_question: 'Permission / lock', unknown: 'Unclear intent', financial_advice: 'Financial / tax decision', instruction_attack: 'Embedded instructions', locked_record: 'Locked record', access: 'Access issue', bug: 'Possible bug', churn: 'Churn signal', uncertain: 'Uncertain' };
const statusLabels = { pending: 'Pending human review', approved_not_sent: 'Approved · not sent', rejected: 'Rejected', escalated: 'Escalation recorded' };
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
async function api(path, value) {
  if (window.supportLabCloudApi) return window.supportLabCloudApi(path, value);
  const response = await fetch(path, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'The local service could not complete that operation.');
  return data;
}
function setView(view) {
  state.view = view;
  for (const name of ['workspace', 'knowledge', 'records', 'guide']) $(`${name}View`).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  if (view === 'records') renderRecords();
}
function renderSamples() {
  const query = $('sampleSearch').value.trim().toLowerCase();
  const list = $('sampleList'); list.replaceChildren();
  const samples = state.bootstrap.tickets.filter(ticket => `${ticket.id} ${ticket.title} ${ticket.subject} ${ticket.body}`.toLowerCase().includes(query));
  for (const ticket of samples) {
    const button = node('button', `sample-button${ticket.id === state.selected ? ' selected' : ''}`);
    button.type = 'button'; button.disabled = state.busy;
    button.setAttribute('aria-pressed', String(ticket.id === state.selected));
    const top = node('span', 'sample-top'); top.append(node('span', '', ticket.id), node('span', '', 'SYNTHETIC'));
    button.append(top, node('span', 'sample-title', ticket.title), node('span', 'sample-group', ticket.group));
    button.addEventListener('click', () => selectSample(ticket)); list.append(button);
  }
  if (!samples.length) list.append(node('p', 'evidence-intro', 'No samples match this search.'));
  $('sampleCount').textContent = String(state.bootstrap.tickets.length);
}
function selectSample(ticket) {
  if (state.busy) return;
  state.selected = ticket.id; state.run = null; state.dirty = false;
  $('subject').value = ticket.subject; $('emailBody').value = ticket.body;
  $('sampleLabel').textContent = `${ticket.id} · SYNTHETIC`;
  message(); renderSamples(); renderRun();
}
function sourceCard(source, expanded = false) {
  const card = node('article', 'source-card');
  card.append(node('span', 'source-id', `${source.id} · OFFICIAL PUBLIC ARTICLE`), node('h3', '', source.title), node('p', '', source.summary));
  const link = node('a', '', 'Read official article ↗'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
  const details = node('details'); details.open = expanded; details.append(node('summary', '', 'Inspect curated facts'));
  const facts = node('ul'); for (const fact of source.facts) facts.append(node('li', '', fact)); details.append(facts);
  if (source.conditions.length) details.append(node('div', 'conditions', source.conditions.join(' ')));
  card.append(details, node('span', 'source-meta', `Source updated ${source.source_updated}`), node('span', 'source-meta', `Curated review ${source.reviewed_at} · ${source.locator}`));
  return card;
}
function renderSources() {
  const sources = state.run ? state.run.sources : state.bootstrap.articles;
  $('evidenceCount').textContent = String(sources.length);
  $('evidenceIntro').textContent = state.run ? 'Selected evidence from the active collection. Check its relevance and conditions.' : 'The curated public collection. Selected evidence appears after analysis.';
  $('sourceList').replaceChildren(...sources.map(source => sourceCard(source)));
  if (!sources.length) $('sourceList').append(node('p', 'evidence-intro', 'No sufficiently relevant source was found in this small collection. Ask a person; do not infer that the feature is unavailable.'));
}
function syncButtons() {
  const ready = Boolean(state.bootstrap);
  const connected = ready && state.bootstrap.mode !== 'not_connected';
  $('analyseButton').disabled = !ready || !connected || state.busy || !$('subject').value.trim() || !$('emailBody').value.trim();
  $('analyseLabel').textContent = state.busy ? 'Working…' : state.bootstrap?.mode === 'rules_rehearsal' ? 'Run rehearsal' : 'Analyse email';
  const reviewable = state.run && !state.busy && !state.dirty && state.run.review_status === 'pending';
  $('approveButton').disabled = !reviewable || state.run?.status !== 'ready' || !$('draftText').value.trim();
  $('rejectButton').disabled = !reviewable; $('escalateButton').disabled = !reviewable;
  $('subject').disabled = state.busy; $('emailBody').disabled = state.busy;
  const locked = !reviewable;
  for (const id of ['draftText', 'reviewNote', 'knowledgeProposal']) $(id).disabled = locked;
  $('dirtyNotice').hidden = !state.dirty;
}
function renderRun() {
  const run = state.run;
  $('emptyState').hidden = Boolean(run); $('runContent').hidden = !run;
  $('runStatus').textContent = run ? statusLabels[run.review_status].toUpperCase() : 'AWAITING ANALYSIS';
  renderSources();
  if (!run) { syncButtons(); return; }
  $('runError').hidden = !run.error; $('runError').textContent = run.error ? `${run.error.code}: ${run.error.message}` : '';
  $('runMode').textContent = run.mode === 'rules_rehearsal' ? 'Recorded mode: rules rehearsal · no live AI' : run.mode === 'live_ai' ? `Recorded mode: live AI · ${run.provider_metadata?.actual_model || run.model}` : `Recorded mode: ${run.mode.replaceAll('_', ' ')}`;
  const analysis = run.analysis;
  const route = analysis?.route;
  const routeCard = $('routeCard'); routeCard.replaceChildren();
  routeCard.className = `route-card${route !== 'draft' ? ' warning' : ''}`;
  const wording = run.review ? [statusLabels[run.review_status], 'Your review is saved. This record is read-only; no email was sent.'] : route === 'draft' ? ['Draft ready for your review', 'Inspect the facts, conditions and wording before approving.'] : route === 'escalate' ? ['Human handling recommended', 'The risk signal needs judgment; a source link is not a verified fix.'] : route === 'clarify' ? ['More evidence or clarification needed', 'This collection is not enough to support a product answer.'] : ['Analysis unavailable', 'No usable model response has been approved.'];
  const copy = node('div'); copy.append(node('h3', '', wording[0]), node('p', '', wording[1]));
  routeCard.append(node('span', 'route-symbol', route === 'draft' ? '✓' : '↗'), copy);
  $('signalChips').replaceChildren();
  if (analysis) {
    for (const intent of analysis.intents) $('signalChips').append(node('span', 'signal-chip', `Intent: ${labels[intent] || intent}`));
    for (const flag of analysis.risk_flags) $('signalChips').append(node('span', 'signal-chip risk', `Risk: ${labels[flag] || flag}`));
  }
  $('analysisReason').textContent = analysis?.reason || run.error?.message || '';
  $('structureCheck').textContent = `Structure: ${run.checks.structure.replaceAll('_', ' ')}`;
  $('citationCheck').textContent = `Citations: ${run.checks.citations.replaceAll('_', ' ')}`;
  $('draftSourceCount').textContent = `${analysis?.citation_ids.length || 0} CITED SOURCE${analysis?.citation_ids.length === 1 ? '' : 'S'}`;
  $('draftText').value = run.review?.draft ?? analysis?.draft ?? '';
  $('draftEditHint').textContent = run.review ? 'Saved review · read-only · not sent' : 'Editable · never sent by this demo';
  $('reviewNote').value = run.review?.note || '';
  $('knowledgeProposal').value = run.review?.knowledge_proposal?.text || '';
  $('savedReview').hidden = !run.review;
  $('savedReview').textContent = run.review ? `${statusLabels[run.review_status]}. ${run.review.edited ? 'Reviewer edits saved. ' : ''}${run.review.knowledge_proposal ? 'Knowledge proposal awaits content review. ' : ''}Recorded ${new Date(run.review.at).toLocaleString()}.` : '';
  $('runJson').textContent = JSON.stringify(run, null, 2);
  syncButtons();
}
function rememberRun(run) {
  state.bootstrap.runs = [run, ...state.bootstrap.runs.filter(item => item.id !== run.id)].slice(0, 30);
  $('recordCount').textContent = String(state.bootstrap.runs.length);
}
async function generate() {
  if (state.busy) return;
  state.busy = true; message(); syncButtons(); renderSamples();
  try {
    const run = await api('/api/analyse', { subject: $('subject').value.trim(), body: $('emailBody').value.trim(), synthetic: true, sample_id: state.selected });
    state.run = run; state.dirty = false; rememberRun(run);
  } catch (error) { message(error.message); }
  finally { state.busy = false; renderSamples(); renderRun(); }
}
async function saveReview(action) {
  if (!state.run || state.busy || state.dirty) return;
  state.busy = true; message(); syncButtons();
  let saved = false;
  try {
    const run = await api(`/api/runs/${state.run.id}/review`, { expected_version: state.run.review_version, action, draft: $('draftText').value, note: $('reviewNote').value.trim(), knowledge_proposal: $('knowledgeProposal').value.trim() });
    state.run = run; rememberRun(run); message(); saved = true;
  } catch (error) { message(error.message); }
  finally { state.busy = false; renderSamples(); if (saved) renderRun(); else syncButtons(); }
}
function loadRecord(run) {
  if (state.busy) return;
  state.run = run; state.selected = run.input.sample_id; state.dirty = false;
  $('subject').value = run.input.subject; $('emailBody').value = run.input.body;
  $('sampleLabel').textContent = `${run.input.sample_id || 'CUSTOM'} · SAVED RUN`;
  message(); setView('workspace'); renderSamples(); renderRun();
}
function renderRecords() {
  const list = $('recordsList'); list.replaceChildren();
  for (const run of state.bootstrap.runs) {
    const row = node('button', 'record-row'); row.type = 'button';
    const title = node('span'); title.append(node('span', 'record-title', run.input.subject), node('span', 'record-sub', `${run.input.sample_id || 'Custom'} · ${run.id.slice(0, 8)}`));
    row.append(title, node('span', 'record-status', statusLabels[run.review_status]), node('span', 'record-mode', run.mode === 'rules_rehearsal' ? 'Rules · no live AI' : run.mode.replaceAll('_', ' ')), node('span', 'record-sub', new Date(run.created_at).toLocaleString()));
    row.addEventListener('click', () => loadRecord(run)); list.append(row);
  }
  if (!state.bootstrap.runs.length) list.append(node('div', 'records-empty', 'No runs yet. Analyse a synthetic sample to create a traceable record.'));
}
async function refresh() {
  const data = await api('/api/bootstrap'); state.bootstrap = data;
  $('recordCount').textContent = String(data.runs.length); renderRecords();
}
function updateInput() {
  if (state.run) state.dirty = $('subject').value.trim() !== state.run.input.subject || $('emailBody').value.trim() !== state.run.input.body;
  const match = state.bootstrap?.tickets.find(ticket => ticket.subject === $('subject').value.trim() && ticket.body === $('emailBody').value.trim());
  const selected = match?.id || null;
  if (selected !== state.selected) { state.selected = selected; renderSamples(); }
  $('sampleLabel').textContent = `${state.selected || 'CUSTOM'} · SYNTHETIC${state.dirty ? ' · EDITED' : ''}`;
  syncButtons();
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { if (state.bootstrap) setView(button.dataset.view); });
$('sampleSearch').addEventListener('input', () => { if (state.bootstrap) renderSamples(); });
for (const id of ['subject', 'emailBody']) $(id).addEventListener('input', updateInput);
$('draftText').addEventListener('input', syncButtons);
$('analyseButton').addEventListener('click', generate);
$('approveButton').addEventListener('click', () => saveReview('approve'));
$('rejectButton').addEventListener('click', () => saveReview('reject'));
$('escalateButton').addEventListener('click', () => saveReview('escalate'));
$('refreshRecords').addEventListener('click', () => refresh().catch(error => message(error.message)));

async function initialiseWorkspace() {
  if (window.location.protocol === 'file:') {
    document.body.classList.add('file-mode');
    $('fileHelp').hidden = false;
    return;
  }
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) { $('referenceLiveLink').href = '/practice'; $('referenceLiveLink').textContent = 'Local practice workspace'; }
  try {
    await refresh();
    const data = state.bootstrap;
    $('notice').textContent = data.cloud_demo
      ? 'KNOWLEDGE & REVIEW GUIDE · NO MODEL CALLS — public articles, review guidance and optional rules practice. Practice records stay in this browser, separate from live workspace history. No email is sent.'
      : data.mode === 'rules_rehearsal'
      ? 'KNOWLEDGE & REVIEW GUIDE · NO MODEL CALLS — public articles, reviewer guidance and optional rules practice. Local records remain separate from the cloud workspace. No email is sent.'
      : data.mode === 'not_connected'
        ? 'LIVE AI DISABLED IN THIS SESSION — you can inspect samples, sources and saved records without new model calls. No email is sent.'
        : `LIVE AI MODE · ${data.model} — each analysis uses API credits. Synthetic messages only; human review required. No email is sent.`;
    $('notice').classList.toggle('live', !['rules_rehearsal', 'not_connected'].includes(data.mode));
    $('knowledgeVersion').textContent = data.knowledge_version;
    $('knowledgeCards').replaceChildren(...data.articles.map(article => sourceCard(article, true)));
    selectSample(data.tickets[0]);
    setView(state.view);
  } catch (error) {
    $('notice').textContent = window.supportLabCloudApi ? 'CLOUD REHEARSAL UNAVAILABLE — check browser site-storage permissions. Existing records have not been reset.' : 'WORKSPACE UNAVAILABLE — start Open Demo.command, then use the browser page it opens.';
    message(error.message);
  }
}
initialiseWorkspace();
