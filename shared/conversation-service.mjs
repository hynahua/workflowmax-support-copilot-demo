import { advance, assertSynthetic, sensitive, workflowVersion } from './conversation.mjs';
import { AppError } from '../server/errors.mjs';
const fail = (code, message, status = 409) => { throw new AppError(code, message, status); };
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const id = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
const cleanString = (text, limit) => typeof text === 'string' && text.trim() && text.length <= limit && !sensitive(text);

export class ConversationService {
  constructor({ store, provider, corpus, validate, contracts, prompts, timeoutMs, transport }) {
    Object.assign(this, { store, provider, corpus, validate, contracts, prompts, timeoutMs });
    this.transport = transport || new TestTransport(store);
  }
  async availability() { return this.provider.availability ? this.provider.availability() : { enabled: this.provider.mode !== 'not_connected', status: this.provider.mode === 'rules_rehearsal' ? 'rules_only' : 'not_connected', remaining_requests: 0 }; }
  async setModelEnabled(value) { if (!this.provider.setEnabled) fail('MODEL_CONTROL_UNAVAILABLE', 'This workspace has no live model switch.', 409); return this.provider.setEnabled(value); }
  async list() {
    const [recent, attention] = await Promise.all([this.store.list('case'), this.store.listAttentionCases ? this.store.listAttentionCases() : []]);
    // Older handoffs and delivery exceptions must remain findable beyond the recent history page.
    const rows = new Map([...recent, ...attention].map(row => [row.id, row]));
    return Promise.all([...rows.keys()].map(caseId => this.get(caseId)));
  }
  async get(caseId) {
    const row = await this.store.get('case', caseId); if (!row) fail('NOT_FOUND', 'Conversation not found.', 404);
    const record = row.value;
    if (record.busy && Date.now() - Date.parse(record.operation_started_at || record.updated_at) > 120000) {
      record.busy = false; record.status = record.status === 'sending' ? 'delivery_unknown' : 'human_required';
      record.reason = 'An interrupted operation exceeded its lease. Inspect or reconcile; no automatic retry was made.';
      if (record.deliveries.at(-1)?.status === 'sending') record.deliveries.at(-1).status = 'unknown';
      return this.persist(record, record.revision);
    }
    return record;
  }
  async persist(record, expected) {
    record.revision = expected + 1; record.updated_at = stamp();
    await this.store.put('case', record.id, expected, record); return record;
  }
  async create(value) {
    assertSynthetic(value);
    if (Object.keys(value).some(k => !['subject', 'body', 'synthetic', 'event_id'].includes(k)) || !cleanString(value.subject, 200) || !cleanString(value.body, 4000) || !/^[\w-]{1,80}$/.test(value.event_id || '')) fail('INPUT_INVALID', 'Supply a subject, synthetic text and stable event_id.', 400);
    // The event ID is the case key, so concurrent duplicate arrivals cannot create two conversations.
    const existing = await this.store.get('inbound', value.event_id);
    if (existing) {
      if (existing.value.fingerprint !== await hash(JSON.stringify(value))) fail('EVENT_CONFLICT', 'This event ID already belongs to different input.');
      return this.get(existing.value.case_id);
    }
    const record = { live_grant_id: this.provider.grantId || null, id: id(), revision: 0, workflow_version: workflowVersion, subject: value.subject.trim(), synthetic: true, created_at: stamp(), status: 'received', messages: [{ role: 'customer', text: value.body.trim(), event_id: value.event_id, at: stamp() }], turn: 1, clarification_count: 0, attempts: [], overrides: [], sources: [], draft: '', pending_question: null, approval: null, review_history: [], deliveries: [], inbound_events: [value.event_id], busy: false };
    // createInbound atomically appends both the deduplication mapping and initial case.
    await this.store.createInbound(value.event_id, { fingerprint: await hash(JSON.stringify(value)), case_id: record.id }, record);
    return this.process(record);
  }
  async process(record, { resume = false } = {}) {
    record.busy = true; record.operation_started_at = stamp(); record.status = 'processing';
    record = await this.persist(record, record.revision);
    const revision = record.revision;
    try { record = await advance(record, { ...this, resume }); }
    catch { record.status = 'human_required'; record.reason = 'An internal operation failed. Review the context before continuing.'; }
    record.busy = false;
    if (record.status !== 'model_paused') record.resume_stage = null;
    record = await this.persist(record, revision);
    if (['awaiting_review', 'human_required'].includes(record.status)) await this.provider.completeCase?.(record);
    if (record.status === 'clarification_ready') return this.deliver(record.id, record.revision, 'clarification');
    return record;
  }
  async resume(caseId, value) {
    if (!value || Object.keys(value).some(k => k !== 'expected_revision')) fail('RESUME_INVALID', 'Resume accepts only the current conversation revision.', 400);
    const record = await this.get(caseId); this.current(record, value.expected_revision);
    if (record.status !== 'model_paused' || !['triage','draft'].includes(record.resume_stage)) fail('RESUME_NOT_READY', 'Only a saved model-paused step can be resumed.');
    if (record.live_grant_id !== (this.provider.grantId || null)) fail('RESUME_SESSION_CHANGED', 'This paused step belongs to a different authorized session.');
    if (record.provenance.knowledge_hash !== this.corpus.hash || JSON.stringify(record.provenance.prompts) !== JSON.stringify(this.prompts.provenance) || JSON.stringify(record.provenance.schemas) !== JSON.stringify(this.contracts.provenance)) fail('RESUME_EVIDENCE_CHANGED', 'Evidence or contracts changed. A person must review before continuing.');
    const info = await this.availability();
    if (!info.enabled) fail('MODEL_SESSION_BLOCKED', info.stop_reason || 'Turn the model on within its remaining allowance before resuming.');
    return this.process(record, { resume: true });
  }
  async reply(caseId, value) {
    assertSynthetic(value);
    if (Object.keys(value).some(k => !['body', 'synthetic', 'event_id', 'expected_revision'].includes(k)) || !cleanString(value.body, 2000) || !/^[\w-]{1,80}$/.test(value.event_id || '')) fail('INPUT_INVALID', 'Supply a synthetic reply and stable event_id.', 400);
    let record = await this.get(caseId);
    if (record.inbound_events.includes(value.event_id)) {
      if (!record.messages.some(m => m.event_id === value.event_id && m.text === value.body.trim())) fail('EVENT_CONFLICT', 'This event ID already has different text.');
      return record;
    }
    this.current(record, value.expected_revision);
    if (record.status !== 'awaiting_reply') fail('REPLY_NOT_EXPECTED', 'A reply is accepted only after a confirmed clarification test delivery.');
    const latest = record.deliveries.at(-1);
    if (Date.now() - Date.parse(latest.at) > 24 * 3600000) fail('REPLY_EXPIRED', 'The 24-hour demonstration reply window expired. A person must continue.');
    record.messages.push({ role: 'customer', text: value.body.trim(), event_id: value.event_id, at: stamp() });
    record.inbound_events.push(value.event_id); record.turn++;
    return this.process(record);
  }
  current(record, revision) {
    if (!Number.isSafeInteger(revision) || record.revision !== revision || record.busy) fail('STALE_CASE', 'The conversation changed or is busy. Reload its saved state.');
  }
  async review(caseId, value) {
    if (Object.keys(value).some(k => !['expected_revision', 'action', 'draft', 'reviewer', 'note', 'confirmed'].includes(k)) || !['save', 'approve', 'reject', 'handoff'].includes(value.action) || !cleanString(value.reviewer, 80) || typeof value.note !== 'string' || value.note.length > 1000 || sensitive(value.note) || typeof value.draft !== 'string' || value.draft.length > 4500 || sensitive(value.draft)) fail('REVIEW_INVALID', 'Provide a reviewer name, valid action and safe bounded text.', 400);
    let record = await this.get(caseId); this.current(record, value.expected_revision);
    if (!['awaiting_review', 'human_required'].includes(record.status)) fail('REVIEW_NOT_READY', 'This conversation is not awaiting review. Existing approved versions are immutable.');
    const review = { id: id(), at: stamp(), reviewer: value.reviewer.trim(), action: value.action, note: value.note, draft: value.draft, edited: value.draft !== record.draft };
    if (value.action === 'approve') {
      if (value.confirmed !== true || !cleanString(value.draft, 4500) ) fail('APPROVAL_REQUIRED', 'Explicitly confirm the exact non-empty draft after checking its evidence.', 400);
      if (record.provenance.knowledge_hash !== this.corpus.hash) fail('KNOWLEDGE_CHANGED', 'Evidence changed after analysis. A person must recheck before a new analysis.');
      if (record.status === 'human_required' && !value.note.trim()) fail('MANUAL_REVIEW_REQUIRED', 'Explain the human-authored response and handoff decision before approval.', 400);
      record.approval = { ...review, human_authored: record.status === 'human_required', hash: await hash(value.draft), source_hash: this.corpus.hash, transport: 'test_only' };
      record.status = 'approved';
    } else if (value.action === 'reject') record.status = 'rejected';
    else if (value.action === 'handoff') record.status = 'human_required';
    record.draft = value.draft; record.review_history.push(review);
    return this.persist(record, record.revision);
  }
  async send(caseId, value) {
    if (Object.keys(value).some(k => !['expected_revision', 'approved_hash'].includes(k))) fail('SEND_INVALID', 'Send accepts only revision and approved_hash, never replacement text.', 400);
    const record = await this.get(caseId);
    if (record.status === 'sent_test' && value.approved_hash === record.approval?.hash) return record;
    this.current(record, value.expected_revision);
    if (record.status !== 'approved' || !record.approval || value.approved_hash !== record.approval.hash) fail('APPROVED_VERSION_REQUIRED', 'Only the persisted approved version can be transmitted.');
    return this.deliver(caseId, record.revision, 'answer');
  }
  async deliver(caseId, revision, kind) {
    let record = await this.get(caseId); this.current(record, revision);
    const text = kind === 'answer' ? record.approval.draft : record.pending_question;
    const delivery = { id: `${record.id}-${kind}-${kind === 'answer' ? record.approval.id : record.turn}`, kind, body: text, hash: await hash(text), status: 'sending', at: stamp(), transport: 'test_only', receipt: null };
    record.deliveries.push(delivery); record.busy = true; record.operation_started_at = stamp(); record.status = 'sending';
    record = await this.persist(record, revision);
    try {
      const result = await this.transport.send(delivery);
      if (!['sent_test', 'failed', 'unknown'].includes(result.status)) throw new Error('Invalid transport status');
      Object.assign(record.deliveries.at(-1), result);
    } catch { record.deliveries.at(-1).status = 'unknown'; }
    return this.finishDelivery(record);
  }
  async finishDelivery(record) {
    const delivery = record.deliveries.at(-1);
    record.busy = false;
    if (delivery.status === 'sent_test') {
      record.messages.push({ role: 'assistant', text: delivery.body, at: stamp(), delivery_id: delivery.id });
      if (delivery.kind === 'clarification') { record.status = 'awaiting_reply'; record.clarification_count++; record.pending_question = null; }
      else record.status = 'sent_test';
    } else record.status = delivery.status === 'failed' ? 'delivery_failed' : 'delivery_unknown';
    return this.persist(record, record.revision);
  }
  async reconcile(caseId, value) {
    let record = await this.get(caseId); this.current(record, value.expected_revision);
    if (!['delivery_unknown', 'delivery_failed'].includes(record.status)) fail('NOT_UNCERTAIN', 'No delivery needs reconciliation.');
    const result = await this.transport.lookup(record.deliveries.at(-1).id);
    if (!result) fail('DELIVERY_UNRESOLVED', 'No confirmed result is available. Keep this case for human inspection; do not blindly resend.');
    Object.assign(record.deliveries.at(-1), result);
    return this.finishDelivery(record);
  }
}

// This mailbox is a durable application test transport. It never contacts an email service.
export class TestTransport {
  constructor(store, outcome = 'sent_test') { this.store = store; this.outcome = outcome; }
  async send(delivery) {
    const existing = await this.store.get('mail', delivery.id);
    if (existing) return existing.value;
    const result = { status: this.outcome, receipt: this.outcome === 'sent_test' ? `test-${id()}` : null, transport: 'test_only', body: delivery.body, hash: delivery.hash, at: stamp() };
    await this.store.put('mail', delivery.id, -1, result);
    return result;
  }
  async lookup(key) { return (await this.store.get('mail', key))?.value || null; }
}
