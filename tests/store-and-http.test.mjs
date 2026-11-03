import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../server/store.mjs';
import { analyse } from '../server/workflow.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
import { rehearsalProvider } from '../server/providers.mjs';
import { createApp } from '../server/app.mjs';

const corpus = await loadKnowledge();
const provider = rehearsalProvider();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const input = { subject: tickets[0].subject, body: tickets[0].body, synthetic: true, sample_id: 'T-001' };
const reviewOf = run => ({ expected_version: 0, action: 'approve', draft: run.analysis.draft, note: '', knowledge_proposal: '' });

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflowmax-support-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new EventStore(directory).init();
}

test('review, edit and pending knowledge proposal survive a store restart', async t => {
  const store = await temporaryStore(t);
  const run = await store.create(await analyse(input, { corpus, provider }));
  const reviewed = await store.review(run.id, { ...reviewOf(run), draft: 'A reviewer-edited draft.', note: 'Clarify this wording after checking the source.', knowledge_proposal: 'Suggest a clearer article summary.' });
  assert.equal(reviewed.review_status, 'approved_not_sent');
  assert.equal(reviewed.review.edited, true);
  assert.equal(reviewed.review.knowledge_proposal.status, 'pending_content_review');
  const restarted = await new EventStore(store.directory).init();
  assert.deepEqual(await restarted.get(run.id), reviewed);
  assert.equal(corpus.articles[0].summary, 'Creating a basic job and associating it with a client.');
  assert.equal((await restarted.read()).length, 2);
});

test('stale or concurrent approval cannot silently overwrite a review', async t => {
  const store = await temporaryStore(t);
  const run = await store.create(await analyse(input, { corpus, provider }));
  const results = await Promise.allSettled([store.review(run.id, reviewOf(run)), store.review(run.id, reviewOf(run))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_REVIEW');
});

test('sent status and unreasoned knowledge proposals are rejected', async t => {
  const store = await temporaryStore(t);
  const run = await store.create(await analyse(input, { corpus, provider }));
  assert.throws(() => store.review(run.id, { ...reviewOf(run), action: 'send' }));
  await assert.rejects(store.review(run.id, { ...reviewOf(run), knowledge_proposal: 'Change the knowledge.' }), /review reason/);
  assert.equal((await store.get(run.id)).review_status, 'pending');
});

test('corrupt local history is surfaced without resetting records', async t => {
  const store = await temporaryStore(t);
  await appendFile(store.file, 'not valid json\n');
  await assert.rejects(new EventStore(store.directory).init(), /not been silently reset/);
  assert.equal(await readFile(store.file, 'utf8'), 'not valid json\n');
});

test('well-formed JSON with an invalid event shape is still rejected', async t => {
  const store = await temporaryStore(t);
  await appendFile(store.file, JSON.stringify({ id: 'event', type: 'run_created', run_id: 'missing-run' }) + '\n');
  await assert.rejects(new EventStore(store.directory).init(), /could not be validated/);
});

test('HTTP workflow creates and reviews a synthetic run; rejects send and foreign origins', async t => {
  const store = await temporaryStore(t);
  const server = createApp({ corpus, provider, store, tickets });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Training examples/);
  const training = await fetch(`${base}/training-cases.json`); assert.equal(training.status, 200);
  assert.equal((await training.json()).cases.length, 10);
  assert.match((await fetch(`${base}/training.js`)).headers.get('content-type'), /javascript/);
  assert.match(await (await fetch(`${base}/legacy`)).text(), /Knowledge &amp; review guide/);
  const stylesheet = await fetch(`${base}/styles.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  const browserCode = await fetch(`${base}/app.js`);
  assert.equal(browserCode.status, 200);
  assert.match(browserCode.headers.get('content-type'), /javascript/);
  assert.equal(bootstrap.tickets.length, 12);
  assert.equal(bootstrap.articles.length, 3);
  assert.equal(bootstrap.tickets[0].expected, undefined);
  const result = await post('/api/analyse', input);
  assert.equal(result.status, 200);
  const run = await result.json();
  assert.equal(run.analysis.route, 'draft');
  const approved = await post(`/api/runs/${run.id}/review`, reviewOf(run));
  assert.equal((await approved.json()).review_status, 'approved_not_sent');
  assert.equal((await post('/api/send', input)).status, 404);
  assert.equal((await post('/api/analyse', input, 'https://unrelated.example')).status, 403);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  assert.equal((await fetch(`${base}/runtime/events.jsonl`)).status, 404);
  assert.equal((await post('/api/analyse', { ...input, synthetic: false })).status, 400);
  assert.equal((await post('/api/analyse', { ...input, body: 'Different synthetic content.' })).status, 400);
  assert.equal((await post('/api/analyse', { ...input, sample_id: null, body: 'Different synthetic content.' })).status, 200);
  assert.equal((await post('/api/analyse', { ...input, body: 'x'.repeat(18000) })).status, 413);
  const old = await analyse(input, { corpus, provider });
  old.knowledge_hash = 'previous-version';
  await store.create(old);
  assert.equal((await post(`/api/runs/${old.id}/review`, reviewOf(old))).status, 409);
});
