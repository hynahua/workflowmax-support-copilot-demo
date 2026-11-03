import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadKnowledge } from '../server/knowledge.mjs';
import { createBrowserApi, browserStorageKey } from '../share/engine.mjs';

const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const validators = {};
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const name of ['input', 'analysis', 'review', 'knowledge']) validators[name] = ajv.compile(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')));
function memory() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; }
const create = (storage = memory()) => createBrowserApi({ corpus, tickets: tickets.map(({ expected, ...ticket }) => ticket), validators, provenance: { edition: 'test-browser', prompt_version: 'test-v1', prompt_hash: 'test-only' }, storage, cryptoApi: webcrypto });
const input = ticket => ({ subject: ticket.subject, body: ticket.body, sample_id: ticket.id, synthetic: true });
const review = run => ({ expected_version: 0, action: 'approve', draft: run.analysis.draft, note: 'Synthetic test review.', knowledge_proposal: '' });

for (const ticket of tickets) {
  test(`browser rehearsal ${ticket.id} preserves the route, evidence and review boundary`, async () => {
    const api = create();
    const run = await api('/api/analyse', input(ticket));
    assert.equal(run.mode, 'rules_rehearsal');
    assert.equal(run.storage, 'visitor_browser_only');
    assert.equal(run.provider_metadata, null);
    assert.equal(run.analysis.route, ticket.expected.route);
    for (const flag of ticket.expected.signals) assert.ok(run.analysis.risk_flags.includes(flag));
    if (ticket.expected.source) assert.ok(run.sources.some(source => source.id === ticket.expected.source));
    assert.equal(run.checks.content, 'human_review_required');
    assert.equal(run.review_status, 'pending');
  });
}

test('browser review survives reopening, stays isolated and cannot be approved twice', async () => {
  const storage = memory();
  const api = create(storage);
  const run = await api('/api/analyse', input(tickets[0]));
  await assert.rejects(api(`/api/runs/${run.id}/review`, { ...review(run), note: '', knowledge_proposal: 'A pending suggestion.' }), /review reason/);
  const saved = await api(`/api/runs/${run.id}/review`, { ...review(run), draft: 'Edited synthetic reply.', knowledge_proposal: 'A pending suggestion.' });
  assert.equal(saved.review_status, 'approved_not_sent');
  assert.equal(saved.review.knowledge_proposal.status, 'pending_content_review');
  const reopened = await create(storage)('/api/bootstrap');
  assert.deepEqual(reopened.runs[0], saved);
  assert.equal(reopened.cloud_demo, true);
  assert.equal(reopened.tickets[0].expected, undefined);
  assert.deepEqual((await create()('/api/bootstrap')).runs, []);
  await assert.rejects(create(storage)(`/api/runs/${run.id}/review`, review(run)), /already been reviewed/);
});

test('invalid history and unavailable browser storage are visible without erasing data', async () => {
  const storage = memory(); storage.setItem(browserStorageKey, 'damaged-history');
  await assert.rejects(create(storage)('/api/bootstrap'), /not been silently reset/);
  assert.equal(storage.getItem(browserStorageKey), 'damaged-history');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  await assert.rejects(create(blocked)('/api/bootstrap'), /Enable site storage/);
  const full = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  await assert.rejects(create(full)('/api/analyse', input(tickets[0])), /not been saved/);
});

test('tampered evidence, real-data flags, sample mismatches and send actions are refused', async () => {
  const storage = memory(); const api = create(storage);
  await assert.rejects(api('/api/analyse', { ...input(tickets[0]), synthetic: false }), /Invalid input/);
  await assert.rejects(api('/api/analyse', { ...input(tickets[0]), body: 'Different content.' }), /custom synthetic/);
  await assert.rejects(api('/api/send', {}), /no model, email-send/);
  const run = await api('/api/analyse', input(tickets[0]));
  const changed = structuredClone(run); changed.sources[0].url = 'https://unrelated.example/';
  storage.setItem(browserStorageKey, JSON.stringify([changed]));
  await assert.rejects(create(storage)('/api/bootstrap'), /not been silently reset/);
});
