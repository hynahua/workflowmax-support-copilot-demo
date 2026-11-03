import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadKnowledge, retrieve } from '../server/knowledge.mjs';
import { analyse } from '../server/workflow.mjs';
import { rehearsalProvider, unconfiguredProvider } from '../server/providers.mjs';
import { validate } from '../server/validation.mjs';

const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const inputOf = ticket => ({ subject: ticket.subject, body: ticket.body, synthetic: true, sample_id: ticket.id });
const provider = rehearsalProvider();

for (const ticket of tickets) {
  test(`rehearsal ${ticket.id}: ${ticket.title}`, async () => {
    const result = await analyse(inputOf(ticket), { corpus, provider });
    assert.equal(result.status, 'ready');
    assert.equal(result.mode, 'rules_rehearsal');
    assert.equal(result.analysis.route, ticket.expected.route);
    assert.equal(result.review_status, 'pending');
    assert.equal(result.checks.content, 'human_review_required');
    for (const flag of ticket.expected.signals) assert.ok(result.analysis.risk_flags.includes(flag), `Missing ${flag}`);
    if (ticket.expected.source) assert.ok(result.sources.some(source => source.id === ticket.expected.source));
    for (const id of result.analysis.citation_ids) assert.ok(result.sources.some(source => source.id === id));
  });
}

test('mixed intent preserves how-to, complaint and churn together', async () => {
  const run = await analyse(inputOf(tickets[8]), { corpus, provider });
  assert.ok(run.analysis.intents.includes('how_to'));
  assert.ok(run.analysis.intents.includes('complaint'));
  assert.ok(run.analysis.intents.includes('churn_signal'));
});

test('inactive knowledge is excluded; an empty active corpus visibly clarifies', async () => {
  const inactive = { ...corpus, articles: corpus.articles.map(article => ({ ...article, active: false })) };
  assert.deepEqual(retrieve(inputOf(tickets[0]), inactive), []);
  const run = await analyse(inputOf(tickets[0]), { corpus: inactive, provider });
  assert.equal(run.analysis.route, 'clarify');
  assert.deepEqual(run.analysis.citation_ids, []);
  assert.match(run.analysis.reason, /does not establish/);
});

test('a citation to an unavailable source blocks the result', async () => {
  const fake = { mode: 'test_mock', model: 'test-only', generate: async request => ({ ...(await provider.generate(request)), citation_ids: ['K-999'] }) };
  const run = await analyse(inputOf(tickets[0]), { corpus, provider: fake });
  assert.equal(run.status, 'blocked');
  assert.equal(run.error.code, 'UNKNOWN_CITATION');
  assert.equal(run.analysis, null);
});

test('malformed provider output is rejected rather than made to look valid', async () => {
  const fake = { mode: 'test_mock', model: 'test-only', generate: async () => ({ draft: 'An incomplete answer' }) };
  const run = await analyse(inputOf(tickets[0]), { corpus, provider: fake });
  assert.equal(run.status, 'blocked');
  assert.equal(run.error.code, 'SCHEMA_INVALID');
});

test('risk floor overrides a provider draft without losing the original request', async () => {
  const fake = { mode: 'test_mock', model: 'test-only', generate: async request => ({ ...(await provider.generate(request)), risk_flags: [], route: 'draft', draft: 'An unverified fix', citation_ids: [request.sources[0].id] }) };
  const run = await analyse(inputOf(tickets[7]), { corpus, provider: fake });
  assert.equal(run.analysis.route, 'escalate');
  assert.ok(run.analysis.risk_flags.includes('bug'));
  assert.doesNotMatch(run.analysis.draft, /unverified fix/);
  assert.ok(run.analysis.intents.includes('how_to'));
});

test('provider failure is visible and does not expose the exception message', async () => {
  const fake = { mode: 'test_mock', model: 'test-only', generate: async () => { throw new Error('private credential text'); } };
  const run = await analyse(inputOf(tickets[0]), { corpus, provider: fake });
  assert.equal(run.status, 'blocked');
  assert.equal(run.error.code, 'PROVIDER_FAILED');
  assert.doesNotMatch(JSON.stringify(run), /private credential text/);
});

test('missing model access stays explicitly not connected', async () => {
  const run = await analyse(inputOf(tickets[0]), { corpus, provider: unconfiguredProvider() });
  assert.equal(run.mode, 'not_connected');
  assert.equal(run.status, 'blocked');
  assert.equal(run.error.code, 'MODEL_NOT_CONNECTED');
});

test('provider deadline returns a visible timeout and signals cancellation', async () => {
  let signal;
  const slow = { mode: 'test_mock', model: 'test-only', generate: request => { signal = request.signal; return new Promise(() => {}); } };
  const run = await analyse(inputOf(tickets[0]), { corpus, provider: slow, timeoutMs: 10 });
  assert.equal(run.status, 'blocked');
  assert.equal(run.error.code, 'PROVIDER_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('input contract rejects real-data flag, unknown fields and blank content', async () => {
  assert.throws(() => validate('input', { ...inputOf(tickets[0]), synthetic: false }));
  assert.throws(() => validate('input', { ...inputOf(tickets[0]), send: true }));
  await assert.rejects(analyse({ ...inputOf(tickets[0]), body: ' ' }, { corpus, provider }), /must not be blank/);
});

test('a structurally valid citation does not claim factual verification', async () => {
  const run = await analyse(inputOf(tickets[0]), { corpus, provider });
  assert.equal(run.checks.citations, 'passed');
  assert.equal(run.checks.content, 'human_review_required');
  assert.ok(run.knowledge_hash);
  assert.ok(run.prompt_hash);
});
