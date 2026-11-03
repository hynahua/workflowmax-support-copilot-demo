import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../server/conversation-store.mjs';
import { createConversationService } from '../server/conversation-config.mjs';
import { conversationRehearsalProvider, questions, explicitHuman, customerSourceLinks } from '../shared/conversation.mjs';
import { TestTransport } from '../shared/conversation-service.mjs';
import { boundedLiveProvider } from '../shared/live-budget.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
import { unconfiguredProvider } from '../server/providers.mjs';
import { openaiProvider } from '../server/openai-provider.mjs';
import { createApp } from '../server/app.mjs';
import { EventStore } from '../server/store.mjs';
const corpus = await loadKnowledge();
const maya = { subject: 'Does my time save automatically?', body: "Hi, I've entered four hours against the Riverside Café website project. Does this save automatically, or do I need to save it myself?", synthetic: true, event_id: 'maya-initial' };
const reply = record => ({ body: "I'm using the weekly timesheet view.", synthetic: true, event_id: 'maya-reply', expected_revision: record.revision });
const approve = record => ({ action: 'approve', reviewer: 'Omar (synthetic QA)', draft: record.draft + '\nThanks, Omar.', note: 'Checked K-002 facts and conditions.', confirmed: true, expected_revision: record.revision });
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wmax-conversation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConversationStore(directory).init();
  return createConversationService({ corpus, store, provider: conversationRehearsalProvider(), ...options });
}
async function ready(service) { let record = await service.create(maya); assert.equal(record.status, 'awaiting_reply'); return service.reply(record.id, reply(record)); }
function mock(modifier) {
  const base = conversationRehearsalProvider(); const calls = [];
  return { mode: 'test_mock', model: 'test-only', calls, async generate(request) { calls.push(structuredClone({ phase: request.phase, input: request.input, feedback: request.feedback, sources: request.sources })); return modifier(request, await base.generate(request), calls); } };
}
test('Maya: checked automatic question, contextual reply, evidence, explicit approval, exact test send and restart', async t => {
  const provider = mock((_, output) => output); const service = await setup(t, { provider });
  let record = await service.create(maya);
  assert.equal(record.status, 'awaiting_reply'); assert.equal(record.messages[1].text, questions.screen); assert.equal(record.sources.length, 0); assert.equal(provider.calls.length, 1);
  record = await service.reply(record.id, reply(record));
  assert.equal(record.status, 'awaiting_review'); assert.equal(provider.calls.length, 3); assert.deepEqual(provider.calls.map(c => c.phase), ['triage', 'triage', 'draft']);
  assert.match(provider.calls[1].input.body, /four hours.*\nassistant:.*weekly.*\ncustomer:.*weekly/s);
  assert.ok(record.sources.some(s => s.id === 'K-002')); assert.match(record.draft, /Weekly Timesheet Entry/);
  assert.equal(record.attempts.length, 3); assert.equal(record.overrides.length, 3); assert.ok(record.provenance.schemas.triage); assert.ok(record.provenance.prompts.draft);
  const cited = corpus.articles.find(source => source.id === 'K-002');
  assert.ok(record.draft.includes(`${cited.title}: ${cited.url}`));
  assert.doesNotMatch(record.draft, /\[K-\d{3}\]/);
  assert.deepEqual(record.citation_ids, ['K-002']);
  assert.match(record.attempts.at(-1).output.draft, /\[K-002\]/);
  assert.ok(!record.draft.includes(corpus.articles.find(source => source.id === 'K-003').url));
  assert.ok(!record.attempts.at(-1).output.draft.includes(cited.url), 'original model output stays separate from link enrichment');
  assert.deepEqual(record.overrides.at(-1).added_source_ids, ['K-002']);
  const reviewed = await service.review(record.id, approve(record)); assert.equal(reviewed.status, 'approved'); assert.equal(reviewed.deliveries.length, 1);
  const restarted = await createConversationService({ corpus, store: await new ConversationStore(service.store.directory).init(), provider });
  const sent = await restarted.send(record.id, { expected_revision: reviewed.revision, approved_hash: reviewed.approval.hash });
  assert.equal(sent.status, 'sent_test'); assert.equal(sent.deliveries[1].body, reviewed.approval.draft); assert.match(sent.deliveries[1].receipt, /^test-/);
  assert.equal(sent.deliveries[1].hash, reviewed.approval.hash); assert.ok(sent.deliveries[1].body.includes(cited.url));
  assert.doesNotMatch(sent.deliveries[1].body, /\[K-\d{3}\]/);
  assert.deepEqual(await restarted.get(sent.id), sent); assert.equal((await service.store.list('mail')).length, 2);
  assert.deepEqual(await restarted.send(sent.id, { expected_revision: reviewed.revision, approved_hash: reviewed.approval.hash }), sent);
});
test('customer links include only cited retrieved sources, preserve existing links and are idempotent', () => {
  const sources = corpus.articles;
  const first = customerSourceLinks('Supported advice [K-002] [K-003]', ['K-002', 'K-003', 'K-002'], sources);
  assert.deepEqual(first.added_source_ids, ['K-002', 'K-003']);
  assert.deepEqual(first.removed_internal_ids, ['K-002', 'K-003']); assert.doesNotMatch(first.draft, /\[K-/);
  assert.ok(!first.draft.includes(sources.find(s => s.id === 'K-001').url));
  assert.equal(customerSourceLinks(first.draft, ['K-002', 'K-003'], sources).draft, first.draft);
  assert.equal(customerSourceLinks('Manual human response.', [], sources).draft, 'Manual human response.');
});
test('a draft too long after customer links fails visibly rather than presenting unapprovable text', async t => {
  const provider = mock((request, out) => request.phase === 'draft' ? { ...out, draft: 'x'.repeat(4485) + ' [K-002]' } : out);
  const service = await setup(t, { provider }); const record = await ready(service);
  assert.equal(record.status, 'human_required'); assert.equal(record.draft, '');
  assert.equal(record.attempts.filter(a => a.phase === 'draft').length, 4);
  assert.equal(record.deliveries.length, 1);
});
test('explicit human, negation and newly introduced risks stop before retrieval/drafting', async t => {
  assert.equal(explicitHuman("I don't need a person. How do I create a job?"), false);
  assert.equal(explicitHuman('Please connect me to a person.'), true);
  assert.equal(explicitHuman('不需要人工'), false);
  const provider = mock((_, output) => output); const service = await setup(t, { provider });
  const human = await service.create({ ...maya, event_id: 'human', body: 'Please connect me to a person.' });
  assert.equal(human.status, 'human_required'); assert.equal(human.sources.length, 0); assert.equal(human.attempts.length, 1);
  const negative = await service.create({ ...maya, event_id: 'negation', body: "I don't need a person. How do I create a job?" }); assert.equal(negative.status, 'awaiting_review');
  let record = await service.create(maya); record = await service.reply(record.id, { ...reply(record), body: "I pressed Save three times, entries disappear and I'm considering cancelling my subscription." });
  assert.equal(record.status, 'human_required'); assert.deepEqual(record.sources, []); assert.ok(record.triage.risk_flags.includes('bug')); assert.ok(record.triage.risk_flags.includes('churn'));
});
test('empty evidence is a knowledge gap, never a customer clarification or feature denial', async t => {
  const provider = mock((_, out) => ({ ...out, decision: 'retrieve', missing_information: [], clarification: '' }));
  const service = await setup(t, { corpus: { ...corpus, articles: [] }, provider });
  const record = await service.create(maya); assert.equal(record.status, 'human_required'); assert.match(record.reason, /does not establish/); assert.equal(record.attempts.length, 1); assert.equal(record.deliveries.length, 0);
});
for (const succeedOn of [1, 2, 3, 4, 5]) test(`draft repair stops at success ${succeedOn}, or at four attempts`, async t => {
  let n = 0;
  const provider = mock((request, out) => request.phase === 'draft' && ++n < succeedOn ? { ...out, citation_ids: ['K-999'] } : out);
  const service = await setup(t, { provider }); const record = await ready(service);
  assert.equal(n, Math.min(succeedOn, 4)); assert.equal(record.status, succeedOn > 4 ? 'human_required' : 'awaiting_review');
  for (const call of provider.calls.filter(c => c.phase === 'draft').slice(1)) { assert.match(call.feedback[0], /retrieved source IDs/); assert.deepEqual(call.sources, provider.calls.find(c => c.phase === 'draft').sources); }
});
test('bad draft structure is repairable; bad triage structure is not retried', async t => {
  for (const phase of ['triage', 'draft']) {
    const provider = mock((request, out) => request.phase === phase ? { broken: true } : out);
    const service = await setup(t, { provider }); let record = await service.create(maya);
    if (phase === 'draft') record = await service.reply(record.id, reply(record));
    assert.equal(record.status, 'human_required'); assert.equal(provider.calls.filter(c => c.phase === phase).length, phase === 'draft' ? 4 : 1);
  }
});
test('conflict and missing evidence from stage two hand off without repairs', async t => {
  const provider = mock((request, out) => request.phase === 'draft' ? { ...out, decision: 'handoff', draft: '', citation_ids: [], reason: 'Active sources conflict; their applicability is unverified.' } : out);
  const service = await setup(t, { provider }); const record = await ready(service); assert.equal(record.status, 'human_required'); assert.equal(provider.calls.filter(c => c.phase === 'draft').length, 1); assert.equal(record.deliveries.length, 1);
});
test('stage two may clarify customer information; questions are checked, not repaired', async t => {
  const provider = mock((request, out) => request.phase === 'draft' ? { ...out, decision: 'clarify', missing_information: ['task'], clarification: questions.task, draft: '', citation_ids: [] } : out);
  const service = await setup(t, { provider }); let record = await ready(service); assert.equal(record.status, 'awaiting_reply'); assert.equal(record.messages.at(-1).text, questions.task);
  record = await service.reply(record.id, { ...reply(record), event_id: 'second-reply', body: 'I am entering time for the design task.' });
  assert.equal(record.status, 'human_required'); assert.match(record.reason, /repeats/);
});
test('unsafe and repeated clarification is blocked before transport', async t => {
  const provider = mock((request, out) => request.phase === 'triage' ? { ...out, decision: 'clarify', missing_information: ['screen'], clarification: 'Send your password to support.' } : out);
  const service = await setup(t, { provider }); const record = await service.create(maya); assert.equal(record.status, 'human_required'); assert.equal(record.deliveries.length, 0);
});
test('provider exceptions, timeout, auth and permission fail visibly without retry or private details', async t => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0; const provider = openaiProvider({ apiKey: 'fake-only', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'private detail' } }), { status }); } });
    const service = await setup(t, { provider }); const record = await service.create(maya); assert.equal(record.status, 'human_required'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(record), /private detail|fake-only/);
  }
  const provider = { mode: 'test_mock', generate: () => new Promise(() => {}) };
  const service = await setup(t, { provider, timeoutMs: 5 }); const record = await service.create(maya); assert.equal(record.error.code, 'PROVIDER_TIMEOUT'); assert.equal(record.attempts.length, 1);
});
test('approval binds exact body, rejects missing confirmation, stale concurrent review and send replacement', async t => {
  const service = await setup(t); const record = await ready(service);
  await assert.rejects(service.send(record.id, { expected_revision: record.revision, approved_hash: 'no' }), { code: 'APPROVED_VERSION_REQUIRED' });
  await assert.rejects(service.review(record.id, { ...approve(record), confirmed: false }), { code: 'APPROVAL_REQUIRED' });
  const results = await Promise.allSettled([service.review(record.id, approve(record)), service.review(record.id, approve(record))]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const approved = await service.get(record.id);
  await assert.rejects(service.send(record.id, { expected_revision: approved.revision, approved_hash: approved.approval.hash, body: 'replacement' }), { code: 'SEND_INVALID' });
  await assert.rejects(service.review(record.id, { ...approve(approved), draft: 'Changed again.' }), { code: 'REVIEW_NOT_READY' });
});
test('save edits and rejection persist without sending', async t => {
  const service = await setup(t); let record = await ready(service);
  record = await service.review(record.id, { ...approve(record), action: 'save' }); assert.equal(record.status, 'awaiting_review'); assert.equal(record.approval, null); assert.equal(record.deliveries.length, 1);
  record = await service.review(record.id, { ...approve(record), action: 'reject' }); assert.equal(record.status, 'rejected'); assert.equal(record.deliveries.length, 1);
});
test('delivery failure and unknown states are distinct; uncertain acceptance reconciles without resend', async t => {
  for (const outcome of ['failed', 'unknown']) {
    const service = await setup(t); service.transport = new TestTransport(service.store, outcome);
    const record = await service.create(maya); assert.equal(record.status, outcome === 'failed' ? 'delivery_failed' : 'delivery_unknown');
    await assert.rejects(service.send(record.id, { expected_revision: record.revision, approved_hash: 'x' }));
  }
  const service = await setup(t); const base = service.transport; let sends = 0;
  service.transport = { send: async d => { sends++; await base.send(d); throw Error('lost response'); }, lookup: key => base.lookup(key) };
  let record = await service.create(maya); assert.equal(record.status, 'delivery_unknown'); record = await service.reconcile(record.id, { expected_revision: record.revision });
  assert.equal(record.status, 'awaiting_reply'); assert.equal(sends, 1); assert.equal((await service.store.list('mail')).length, 1);
});
test('incoming deduplication, concurrent replies and process restart recovery', async t => {
  const service = await setup(t); let record = await service.create(maya); assert.deepEqual(await service.create(maya), record);
  await assert.rejects(service.create({ ...maya, body: 'Different text.' }), { code: 'EVENT_CONFLICT' });
  const results = await Promise.allSettled([service.reply(record.id, reply(record)), service.reply(record.id, reply(record))]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  record = await service.get(record.id); record.busy = true; record.status = 'sending'; record.deliveries.push({ status: 'sending' }); await service.persist(record, record.revision);
  const restarted = await new ConversationStore(service.store.directory).init(); await restarted.recover(); record = (await restarted.get('case', record.id)).value;
  assert.equal(record.status, 'delivery_unknown'); assert.equal(record.busy, false);
});
test('default offline, corrupt storage and credentials fail closed', async t => {
  const service = await setup(t, { provider: unconfiguredProvider() }); const record = await service.create(maya); assert.equal(record.error.code, 'MODEL_NOT_CONNECTED');
  await assert.rejects(service.create({ ...maya, event_id: 'private', body: 'password=secretvalue' }), { code: 'SENSITIVE_INPUT' });
  assert.doesNotMatch(await readFile(service.store.file, 'utf8'), /secretvalue/);
  await appendFile(service.store.file, '{bad json\n'); await assert.rejects(new ConversationStore(service.store.directory).init(), { code: 'STORE_CORRUPT' });
});
test('persisted live request/cost gate counts before I/O, survives restart, defaults to zero', async t => {
  const service = await setup(t); let calls = 0; const provider = { mode: 'live_ai', model: 'test-only', generate: async () => { calls++; throw Error('network'); } };
  const request = { instructions: 'test', input: { subject: 'test' } };
  await assert.rejects(boundedLiveProvider(provider, { strategy: 'one_case', store: service.store, grant: null }).generate(request), { code: 'LIVE_BUDGET_REQUIRED' }); assert.equal(calls, 0);
  const grant = { id: 'synthetic-test-grant', max_requests: 1, max_usd: 0.02, expires_at: new Date(Date.now() + 60000).toISOString() };
  await assert.rejects(boundedLiveProvider(provider, { strategy: 'one_case', store: service.store, grant }).generate(request)); assert.equal(calls, 1);
  const restarted = await new ConversationStore(service.store.directory).init(); await assert.rejects(boundedLiveProvider(provider, { strategy: 'one_case', store: restarted, grant }).generate(request), { code: 'LIVE_BATCH_STOPPED' }); assert.equal(calls, 1);
  await assert.rejects(boundedLiveProvider(provider, { strategy: 'one_case', store: restarted, grant: { ...grant, max_requests: 2 } }).generate(request), { code: 'LIVE_GRANT_CHANGED' });
});
test('two-stage Responses adapter requests match phase schemas and preserve the whole conversation', async t => {
  const rehearsal = conversationRehearsalProvider(); let calls = 0;
  const provider = openaiProvider({ apiKey: 'fake-placeholder', fetchImpl: async (_, options) => {
    calls++; const payload = JSON.parse(options.body); const data = JSON.parse(payload.input[0].content[0].text);
    assert.equal(payload.store, false); assert.equal(payload.max_output_tokens, 1800); assert.equal(payload.tools, undefined); assert.equal(payload.text.format.schema.$id, undefined); assert.match(payload.text.format.name, /support_(triage|draft)_v2/);
    const output = await rehearsal.generate({ phase: data.phase, input: data.synthetic_email, context: data.conversation, sources: data.retrieved_evidence });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
  } });
  const service = await setup(t, { provider }); const record = await ready(service); assert.equal(record.status, 'awaiting_review'); assert.equal(calls, 3);
});
test('HTTP conversation flow and historical records remain separate', async t => {
  const service = await setup(t); const legacy = await new EventStore(service.store.directory).init(); const server = createApp({ corpus, provider: conversationRehearsalProvider(), store: legacy, tickets: [], conversations: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}`;
  const home = await (await fetch(base)).text(); assert.match(home, /Training examples/);
  assert.match(await (await fetch(base + '/practice')).text(), /Conversation and next step/);
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(value) });
  const response = await post('/api/conversations', maya); assert.equal(response.status, 200); const record = await response.json(); assert.equal(record.status, 'awaiting_reply'); assert.equal((await legacy.list()).length, 0);
  assert.equal((await post(`/api/conversations/${record.id}/reply`, { ...reply(record), synthetic: false })).status, 400);
  assert.equal((await fetch(base + '/.env.local')).status, 404);
});

test('legacy generation cannot bypass live budget', async t => {
  let calls = 0; const service = await setup(t); const legacy = await new EventStore(service.store.directory).init();
  const server = createApp({ corpus, provider: { mode: 'live_ai', generate: async () => { calls++; } }, store: legacy, tickets: [], conversations: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'LEGACY_LIVE_DISABLED'); assert.equal(calls, 0);
});

test('a person can compose and approve a handoff response with an explicit manual review note', async t => {
  const service = await setup(t); let record = await service.create({ ...maya, body: 'Please connect me to a person.' });
  const manual = { ...approve(record), draft: 'Hi Maya, I will handle this request personally. Thanks, Omar.', note: '' };
  await assert.rejects(service.review(record.id, manual), { code: 'MANUAL_REVIEW_REQUIRED' });
  record = await service.review(record.id, { ...manual, note: 'Synthetic QA: manually authored acknowledgement; no product instructions or account actions.' });
  assert.equal(record.approval.human_authored, true);
  record = await service.send(record.id, { expected_revision: record.revision, approved_hash: record.approval.hash });
  assert.equal(record.status, 'sent_test'); assert.equal(record.attempts.length, 1);
});
test('concurrent answer sends reserve one delivery and changed evidence prevents approval', async t => {
  const service = await setup(t); let record = await ready(service);
  const original = service.corpus; service.corpus = { ...corpus, hash: 'changed' };
  await assert.rejects(service.review(record.id, approve(record)), { code: 'KNOWLEDGE_CHANGED' }); service.corpus = original;
  record = await service.review(record.id, approve(record));
  const send = { expected_revision: record.revision, approved_hash: record.approval.hash };
  const results = await Promise.allSettled([service.send(record.id, send), service.send(record.id, send)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await service.store.list('mail')).length, 2);
});
test('unanswered expiry and two-question ceiling cannot form an infinite clarification loop', async t => {
  const service = await setup(t); let record = await service.create(maya);
  record.deliveries.at(-1).at = new Date(Date.now() - 25*3600000).toISOString(); record = await service.persist(record, record.revision);
  await assert.rejects(service.reply(record.id, reply(record)), { code: 'REPLY_EXPIRED' });
  record.deliveries.at(-1).at = new Date().toISOString(); record.clarification_count = 2; record = await service.persist(record, record.revision);
  service.provider = mock((request, out) => request.phase === 'draft' ? { ...out, decision: 'clarify', missing_information: ['task'], clarification: questions.task, draft: '', citation_ids: [] } : out);
  record = await service.reply(record.id, reply(record)); assert.equal(record.status, 'human_required'); assert.equal(record.error.code, 'CLARIFICATION_LIMIT');
});

test('fixed human-request constraint corrects a model false positive on explicit negation', async t => {
  const provider = mock((request, output) => request.phase === 'triage' ? { ...output, human_requested: true, decision: 'handoff' } : output);
  const service = await setup(t, { provider });
  const record = await service.create({ ...maya, body: "I don't need a person. How do I create a job?" });
  assert.equal(record.status, 'awaiting_review'); assert.equal(record.overrides[0].original.human_requested, true); assert.equal(record.overrides[0].effective.human_requested, false);
});
test('completed, exhausted and expired live grants report no generatable requests', async t => {
  const service = await setup(t); let calls = 0;
  const base = { mode: 'live_ai', model: 'test-only', generate: async () => { calls++; return {}; } };
  const grant = { id: 'availability-test', max_requests: 1, max_usd: 0.02, expires_at: new Date(Date.now() + 60000).toISOString() };
  const provider = boundedLiveProvider(base, { strategy: 'one_case', store: service.store, grant }); assert.equal((await provider.availability()).remaining_requests, 1);
  await assert.rejects(provider.generate({ instructions: 'x'.repeat(12001) }), { code: 'MODEL_INPUT_LIMIT' }); assert.equal(calls, 0);
  await provider.generate({ instructions: 'small' }); assert.deepEqual((await provider.availability()).enabled, false); assert.equal((await provider.availability()).remaining_requests, 0);
  await assert.rejects(provider.generate({ instructions: 'small' }), { code: 'LIVE_BUDGET_EXHAUSTED' }); assert.equal(calls, 1);
  const expired = boundedLiveProvider(base, { strategy: 'one_case', store: service.store, grant: { ...grant, expires_at: '2000-01-01' } }); assert.equal((await expired.availability()).enabled, false);
});

test('one process lease protects the global budget across independently selected case directories', async t => {
  const service = await setup(t); const other = await new ConversationStore(service.store.directory).init();
  await service.store.acquireProcessLease();
  try { await assert.rejects(other.acquireProcessLease(), { code: 'STORE_BUSY' }); }
  finally { await service.store.releaseLease(); }
  await other.acquireProcessLease(); await other.releaseLease();
});

test('a bounded live batch closes automatically when its one conversation reaches review', async t => {
  const service = await setup(t); const grant = { id: 'one-case-grant', max_requests: 6, max_usd: 0.02, expires_at: new Date(Date.now()+60000).toISOString() };
  service.provider = boundedLiveProvider({ ...conversationRehearsalProvider(), mode: 'live_ai', model: 'mock-live-only' }, { strategy: 'one_case', store: service.store, grant });
  let record = await service.create(maya); assert.equal(record.status, 'awaiting_reply'); assert.equal((await service.availability()).remaining_requests, 5);
  record = await service.reply(record.id, reply(record)); assert.equal(record.status, 'awaiting_review'); assert.equal((await service.availability()).enabled, false);
  const budget = (await service.store.get('budget', grant.id)).value; assert.equal(budget.requests, 3); assert.equal(budget.halted, true);
});
