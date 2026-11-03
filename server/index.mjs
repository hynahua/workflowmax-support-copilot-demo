import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from './app.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { EventStore } from './store.mjs';
import { rehearsalProvider, unconfiguredProvider } from './providers.mjs';
import { ConversationStore } from './conversation-store.mjs';
import { createConversationService } from './conversation-config.mjs';
import { conversationRehearsalProvider } from '../shared/conversation.mjs';
import { boundedLiveProvider } from '../shared/live-budget.mjs';
import { configuredLiveProvider } from './live-config.mjs';

const rehearsal = process.argv.includes('--rehearsal');
const live = process.argv.includes('--live');
if (live && rehearsal) throw new Error('Choose either live AI or rules rehearsal.');
const provider = rehearsal ? rehearsalProvider() : live ? configuredLiveProvider() : unconfiguredProvider();
const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const demoLaunch = process.argv.includes('--open-browser');
const directory = process.env.DEMO_DATA_DIR || fileURLToPath(new URL(demoLaunch ? '../runtime/live-evaluation' : '../runtime', import.meta.url));
const store = await new EventStore(directory).init();
const conversationStore = await new ConversationStore(directory).init();
await conversationStore.acquireProcessLease();
await conversationStore.recover();
let grant = null;
if (live) { try { grant = JSON.parse(await readFile(new URL('../runtime/approved-live-plan.json', import.meta.url), 'utf8')); } catch {} }
const budgetStore = await new ConversationStore(new URL('../runtime/live-budget-ledger/', import.meta.url).pathname).init();
if (live) await budgetStore.acquireProcessLease();
const conversationProvider = rehearsal ? conversationRehearsalProvider() : live ? boundedLiveProvider(provider, { store: budgetStore, grant }) : provider;
const conversations = await createConversationService({ corpus, provider: conversationProvider, store: conversationStore });
const server = createApp({ corpus, provider, store, tickets, conversations });
const autoPort = process.argv.includes('--auto-port');
const port = autoPort ? 0 : Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || (!autoPort && (port < 1024 || port > 65535))) throw new Error('PORT must be an integer from 1024 to 65535.');
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`WorkflowMAX Support Lab: ${url}`);
  console.log(`Training examples: ${url}/ — Conversation practice and saved local records: ${url}/practice`);
  console.log(rehearsal ? 'Mode: rules rehearsal — no live AI, test transport only; no real email.' : live ? `Mode: live AI (${provider.model}) — conversation requests require an active persisted grant; human review and test transport only; no real email.` : 'Mode: live AI disabled — use the explicit live command only within an approved usage plan.');
  if (demoLaunch && process.platform === 'darwin') {
    const opener = spawn('open', [url], { stdio: 'ignore' });
    opener.on('error', () => console.log(`Open this address in your browser: ${url}`));
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await conversationStore.releaseLease(); await budgetStore.releaseLease?.(); process.exit(0); }));
