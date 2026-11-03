import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadKnowledge } from '../server/knowledge.mjs';
import { rehearsalProvider } from '../server/providers.mjs';
import { analyse } from '../server/workflow.mjs';

const corpus = await loadKnowledge();
const provider = rehearsalProvider();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
const results = [];
for (const ticket of tickets) {
  const input = { subject: ticket.subject, body: ticket.body, synthetic: true, sample_id: ticket.id };
  const run = await analyse(input, { corpus, provider });
  const checks = {
    usable: run.status === 'ready',
    route: run.analysis?.route === ticket.expected.route,
    flags: ticket.expected.signals.every(flag => run.analysis?.risk_flags.includes(flag)),
    source: !ticket.expected.source || run.sources.some(source => source.id === ticket.expected.source),
    human_review: run.review_status === 'pending' && run.checks.content === 'human_review_required'
  };
  results.push({ case_id: ticket.id, expected: ticket.expected, passed: Object.values(checks).every(Boolean), checks, run });
}
const report = { evaluated_at: new Date().toISOString(), mode: 'rules_rehearsal', live_ai_evaluated: false, limitation: 'These cases check deterministic routing, retrieval and workflow boundaries. They do not measure live model accuracy, factual entailment or real business value.', total: results.length, passed: results.filter(result => result.passed).length, results };
const directory = new URL('../runtime/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('rehearsal-evaluation.json', directory), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Rules rehearsal: ${report.passed}/${report.total} cases passed. No live AI was evaluated.`);
console.log('Saved runtime/rehearsal-evaluation.json');
if (report.passed !== report.total) process.exitCode = 1;
