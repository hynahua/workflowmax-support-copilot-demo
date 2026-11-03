import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiProvider, liveModel, maxOutputTokens } from '../server/openai-provider.mjs';
import { configuredLiveProvider } from '../server/live-config.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
import { analyse } from '../server/workflow.mjs';

const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const ticket = tickets[0];
const input = { subject: ticket.subject, body: ticket.body, sample_id: ticket.id, synthetic: true };
const analysis = { summary: 'Create a job.', intents: ['how_to'], risk_flags: [], route: 'draft', reason: 'Use the selected evidence.', draft: 'A job must be associated with a client [K-001].', citation_ids: ['K-001'] };
const envelope = (overrides = {}) => ({ id: 'resp_test_only', model: liveModel, status: 'completed', usage: { input_tokens: 500, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }], ...overrides });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fakeKey = 'test-only-placeholder';

test('live configuration uses only the selected file even when an unrelated key is inherited', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflowmax-key-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, '.env.local');
  await writeFile(envFile, `OPENAI_API_KEY="${fakeKey}"\n`, { mode: 0o600 });
  const inherited = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unrelated-test-placeholder';
  try {
    const provider = configuredLiveProvider({ envFile, fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
      return response(envelope());
    } });
    const run = await analyse(input, { corpus, provider });
    assert.equal(run.status, 'ready');
    assert.equal(process.env.OPENAI_API_KEY, 'unrelated-test-placeholder');
  } finally {
    if (inherited === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = inherited;
  }
});

test('live adapter sends only scoped data, a strict contract and no tools or stored conversation', async () => {
  let calls = 0;
  const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    assert.ok(options.signal instanceof AbortSignal);
    const request = JSON.parse(options.body);
    assert.equal(request.model, liveModel);
    assert.equal(request.max_output_tokens, maxOutputTokens);
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.schema.additionalProperties, false);
    const data = JSON.parse(request.input[0].content[0].text);
    assert.deepEqual(data.synthetic_email, { subject: input.subject, body: input.body });
    assert.ok(data.retrieved_evidence.length);
    assert.deepEqual(Object.keys(data).sort(), ['retrieved_evidence', 'synthetic_email']);
    assert.equal(data.expected, undefined);
    assert.doesNotMatch(options.body, /test-only-placeholder|workflowmax-interview-materials/);
    return response(envelope());
  } });
  const run = await analyse(input, { corpus, provider });
  assert.equal(calls, 1);
  assert.equal(run.mode, 'live_ai');
  assert.equal(run.status, 'ready');
  assert.deepEqual(run.provider_analysis, analysis);
  assert.equal(run.provider_metadata.response_id, 'resp_test_only');
  assert.equal(run.provider_metadata.input_tokens, 500);
  assert.equal(run.review_status, 'pending');
  assert.doesNotMatch(JSON.stringify(run), /test-only-placeholder/);
});

for (const [status, code, expected] of [[401, 'invalid_api_key', 'MODEL_AUTH_FAILED'], [403, 'permission_denied', 'MODEL_ACCESS_DENIED'], [429, 'insufficient_quota', 'MODEL_QUOTA_EXHAUSTED'], [429, 'rate_limit_exceeded', 'MODEL_RATE_LIMITED'], [500, 'server_error', 'MODEL_REQUEST_FAILED']]) {
  test(`HTTP ${status}/${code} stays blocked and does not retry or expose an error body`, async () => {
    let calls = 0;
    const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async () => { calls++; return response({ error: { code, message: 'private account detail' } }, status); } });
    const run = await analyse(input, { corpus, provider });
    assert.equal(calls, 1);
    assert.equal(run.error.code, expected);
    assert.equal(run.status, 'blocked');
    assert.equal(run.analysis, null);
    assert.doesNotMatch(JSON.stringify(run), /private account detail|test-only-placeholder/);
  });
}

for (const [name, data, code] of [
  ['incomplete', envelope({ status: 'incomplete' }), 'MODEL_INCOMPLETE'],
  ['refusal', envelope({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'declined' }] }] }), 'MODEL_REFUSED'],
  ['empty', envelope({ output: [] }), 'MODEL_RESPONSE_INVALID'],
  ['invalid JSON', envelope({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{' }] }] }), 'MODEL_RESPONSE_INVALID']
]) {
  test(`${name} cannot become an approvable draft`, async () => {
    const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async () => response(data) });
    const run = await analyse(input, { corpus, provider });
    assert.equal(run.error.code, code);
    assert.equal(run.analysis, null);
    assert.equal(run.provider_metadata.output_tokens, 100);
  });
}

test('local full contract still catches duplicates omitted from the API schema subset', async () => {
  const data = envelope({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...analysis, intents: ['how_to', 'how_to'] }) }] }] });
  const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async () => response(data) });
  const run = await analyse(input, { corpus, provider });
  assert.equal(run.error.code, 'SCHEMA_INVALID');
});

test('network errors and oversized responses stay visible without exposing private details', async () => {
  for (const fetchImpl of [async () => { throw new Error('private network detail'); }, async () => new Response('x'.repeat(262145))]) {
    const run = await analyse(input, { corpus, provider: openaiProvider({ apiKey: fakeKey, fetchImpl }) });
    assert.equal(run.status, 'blocked');
    assert.match(run.error.code, /^MODEL_(NETWORK_FAILED|RESPONSE_INVALID)$/);
    assert.doesNotMatch(JSON.stringify(run), /private network detail/);
  }
  assert.throws(() => openaiProvider(), /server-side/);
});

test('model decision stays available separately when the deterministic floor overrides it', async () => {
  const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async () => response(envelope()) });
  const run = await analyse({ ...input, body: 'How do I create a job? This is unacceptable and I am unhappy.', sample_id: null }, { corpus, provider });
  assert.equal(run.provider_analysis.route, 'draft');
  assert.equal(run.analysis.route, 'escalate');
  assert.ok(run.analysis.risk_flags.includes('complaint'));
});

test('manual redirect mode is Worker-compatible and rejects redirects without forwarding credentials', async () => {
  let calls = 0;
  const provider = openaiProvider({ apiKey: fakeKey, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode in Workers');
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://unapproved.example' } });
  } });
  const run = await analyse(input, { corpus, provider });
  assert.equal(run.error.code, 'MODEL_REDIRECT_REJECTED'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(run), /test-only-placeholder|unapproved.example/);
});
