import { readFile, writeFile } from 'node:fs/promises';
import { ConversationStore } from '../server/conversation-store.mjs';
import { createConversationService } from '../server/conversation-config.mjs';
import { configuredLiveProvider } from '../server/live-config.mjs';
import { boundedLiveProvider } from '../shared/live-budget.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
if (!process.argv.includes('--approved-six-request-plan')) throw Error('Explicit approved-six-request-plan flag required. No model request was made.');
const grant = JSON.parse(await readFile(new URL('../runtime/approved-live-plan.json', import.meta.url), 'utf8'));
const directory = new URL('../runtime/conversation-live-evaluation/', import.meta.url).pathname;
const store = await new ConversationStore(directory).init();
const budgetStore = await new ConversationStore(new URL('../runtime/live-budget-ledger/', import.meta.url).pathname).init(); await store.acquireProcessLease();
try {
  await budgetStore.acquireProcessLease();
  await store.recover();
  const service = await createConversationService({ corpus: await loadKnowledge(), store, provider: boundedLiveProvider(configuredLiveProvider(), { store: budgetStore, grant, strategy: 'one_case' }) });
  let record = await service.create({ subject: 'Does my time save automatically?', body: "Hi, I've entered four hours against the Riverside Café website project. Does this save automatically, or do I need to save it myself?", synthetic: true, event_id: 'approved-maya-v2-initial' });
  if (record.status === 'awaiting_reply') record = await service.reply(record.id, { body: "I'm using the weekly timesheet view.", synthetic: true, event_id: 'approved-maya-v2-reply', expected_revision: record.revision });
  const budgetRow = await budgetStore.get('budget', grant.id);
  if (budgetRow && !budgetRow.value.halted) await budgetStore.put('budget', grant.id, budgetRow.version, { ...budgetRow.value, halted: true, halt_code: 'AUTHORIZED_CASE_GENERATION_FINISHED', stopped_after_request: budgetRow.value.requests });
  const budget = (await budgetStore.get('budget', grant.id))?.value || null;
  const usage = record.attempts.reduce((a, item) => ({ input_tokens: a.input_tokens + (item.metadata?.input_tokens || 0), output_tokens: a.output_tokens + (item.metadata?.output_tokens || 0) }), { input_tokens: 0, output_tokens: 0 });
  const report = { at: new Date().toISOString(), edition: 'two-stage-real-model-synthetic-test-transport', case_id: record.id, status: record.status, requests_reserved: budget?.requests || 0, conservative_reserved_usd: budget?.reserved_usd || 0, budget_halted: budget?.halted || false, usage, approval_and_send: 'Not performed by this script. Inspect evidence and the exact draft before a separately recorded test review.', record };
  await writeFile(new URL('../runtime/conversation-live-evaluation/report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: record.status, case_id: record.id, requests: budget?.requests || 0, usage, error: record.error, report: directory + 'report.json' }));
} finally { await store.releaseLease(); await budgetStore.releaseLease?.(); }
