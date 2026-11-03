throw new Error('The historical single-stage live evaluator is retired. Use npm run eval:conversation:live with the explicitly approved persisted six-request plan.');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configuredLiveProvider } from '../server/live-config.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
import { createApp } from '../server/app.mjs';
import { EventStore } from '../server/store.mjs';
import { liveModel, maxOutputTokens } from '../server/openai-provider.mjs';

if (!process.argv.includes('--confirm-12-live-calls')) {
  console.error('No API requests made. This opt-in evaluation requires an approved twelve-call plan and --confirm-12-live-calls.');
  process.exit(1);
}
const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
if (tickets.length !== 12 || tickets.some(ticket => ticket.synthetic !== true)) throw new Error('Expected exactly twelve synthetic fixtures.');
const provider = configuredLiveProvider();
const directory = new URL('../runtime/live-evaluation/', import.meta.url);
await mkdir(directory, { recursive: true });
const store = await new EventStore(directory.pathname).init();
const server = createApp({ corpus, provider, store, tickets });
const report = {
  evaluated_at: new Date().toISOString(), mode: 'live_ai', model: liveModel,
  max_calls: 12, max_output_tokens_per_call: maxOutputTokens, automatic_retries: 0,
  limitation: 'Automated route, signal and citation-ID checks are separate from manual factual support, raw model quality, business UAT and production outcomes.',
  results: [], completed: false
};
const reportFile = new URL('report.json', directory);
async function save() {
  report.total = report.results.length;
  report.passed = report.results.filter(result => result.passed).length;
  report.input_tokens = report.results.reduce((sum, result) => sum + (result.run.provider_metadata?.input_tokens || 0), 0);
  report.output_tokens = report.results.reduce((sum, result) => sum + (result.run.provider_metadata?.output_tokens || 0), 0);
  // Conservative uncached standard text estimate; not an account invoice or hard spend cap.
  report.estimated_cost_usd = (report.input_tokens * 0.10 + report.output_tokens * 0.50) / 1000000;
  report.pricing_source = 'https://developers.openai.com/api/docs/models/gpt-6-luna';
  report.pricing_checked_at = '2026-11-01';
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const ticket of tickets) {
    const input = { subject: ticket.subject, body: ticket.body, sample_id: ticket.id, synthetic: true };
    const response = await fetch(`${base}/api/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`Local evaluation HTTP failure (${response.status}); stopped without retry.`);
    const run = await response.json();
    const checks = {
      usable: run.status === 'ready',
      route: run.analysis?.route === ticket.expected.route,
      flags: ticket.expected.signals.every(flag => run.analysis?.risk_flags.includes(flag)),
      source: !ticket.expected.source || run.analysis?.citation_ids.includes(ticket.expected.source),
      human_review: run.review_status === 'pending' && run.checks.content === 'human_review_required'
    };
    const raw_model_checks = {
      route: run.provider_analysis?.route === ticket.expected.route,
      flags: ticket.expected.signals.every(flag => run.provider_analysis?.risk_flags.includes(flag))
    };
    report.results.push({ case_id: ticket.id, expected: ticket.expected, passed: Object.values(checks).every(Boolean), checks, raw_model_checks, manual_grounding: 'not_reviewed', run });
    await save();
    console.log(`${ticket.id}: ${run.status}; final route ${run.analysis?.route || 'unavailable'}; ${report.results.at(-1).passed ? 'automated checks passed' : 'needs review'}`);
    if (run.status !== 'ready') {
      console.log(`Stopped after ${report.total} request(s): ${run.error?.code || 'unavailable'}. No retry was made.`);
      break;
    }
  }
  report.completed = report.results.length === 12;
  await save();
  console.log(`Live evaluation: ${report.passed}/${report.total} automated cases passed; manual grounding review remains separate.`);
  console.log(`Tokens: ${report.input_tokens} input, ${report.output_tokens} output. Estimated standard text cost: US$${report.estimated_cost_usd.toFixed(6)}.`);
  console.log('Saved runtime/live-evaluation/report.json and local events. No email was sent.');
  if (!report.completed || report.passed !== 12) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
}
