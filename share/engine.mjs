import { retrieve } from '../shared/knowledge.mjs';
import { rehearsalProvider } from '../shared/rehearsal.mjs';
import { enforceRouting, riskFloor } from '../server/routing.mjs';
import { AppError } from '../server/errors.mjs';

export const browserStorageKey = 'workflowmax-support-cloud-rehearsal-v1';
const reviewStatuses = { approve: 'approved_not_sent', reject: 'rejected', escalate: 'escalated' };

export function createBrowserApi({ corpus, tickets, provenance, validators, storage, cryptoApi = globalThis.crypto, locks = globalThis.navigator?.locks }) {
  const provider = rehearsalProvider();
  const validate = (name, value) => {
    if (!validators[name](value)) throw new AppError('SCHEMA_INVALID', `Invalid ${name}: ${validators[name].errors?.[0]?.message || 'check the fields'}.`);
    return value;
  };
  validate('knowledge', { version: corpus.version, articles: corpus.articles });
  const validateAnalysis = (analysis, sources) => {
    validate('analysis', analysis);
    if (analysis.citation_ids.some(id => !sources.some(source => source.id === id))) throw new AppError('UNKNOWN_CITATION', 'A reference is outside the selected evidence.');
    if (analysis.route === 'draft' && (!analysis.citation_ids.length || !analysis.draft.trim())) throw new AppError('UNSUPPORTED_DRAFT', 'A draft needs evidence and non-empty text.');
  };
  function readRuns() {
    let raw;
    try { raw = storage.getItem(browserStorageKey); }
    catch { throw new AppError('BROWSER_STORAGE_UNAVAILABLE', 'Enable site storage to use this demo. No action has been saved.'); }
    if (raw === null) return [];
    try {
      if (raw.length > 2000000) throw new Error('Oversized history');
      const runs = JSON.parse(raw);
      if (!Array.isArray(runs) || runs.length > 100 || new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('Invalid history');
      for (const run of runs) {
        validate('input', run.input);
        if (!/^[a-f0-9-]{36}$/.test(run.id) || run.mode !== 'rules_rehearsal' || run.status !== 'ready' || run.knowledge_hash !== corpus.hash || run.knowledge_version !== corpus.version) throw new Error('History version mismatch');
        if (JSON.stringify(run.sources) !== JSON.stringify(retrieve(run.input, corpus))) throw new Error('Changed evidence');
        validateAnalysis(run.analysis, run.sources);
        if (![0, 1].includes(run.review_version)) throw new Error('Invalid review version');
        if (run.review_version === 0 && (run.review_status !== 'pending' || run.review)) throw new Error('Invalid pending review');
        if (run.review_version === 1) {
          const review = run.review;
          validate('review', { expected_version: 0, action: review.action, draft: review.draft, note: review.note, knowledge_proposal: review.knowledge_proposal?.text || '' });
          if (review.status !== reviewStatuses[review.action] || run.review_status !== review.status || review.version !== 1) throw new Error('Invalid saved review');
        }
      }
      return runs;
    } catch {
      throw new AppError('BROWSER_HISTORY_INVALID', 'This browser’s demo history could not be validated or belongs to another knowledge version. It has not been silently reset. Use another browser profile for a fresh demo; preserve this history for inspection.');
    }
  }
  function saveRuns(runs) {
    if (runs.length > 100) throw new AppError('BROWSER_HISTORY_LIMIT', 'This browser has reached the 100-run demonstration limit. No existing records were removed.');
    try { storage.setItem(browserStorageKey, JSON.stringify(runs)); }
    catch { throw new AppError('BROWSER_STORAGE_FULL', 'Browser storage is unavailable or full. This action has not been saved.'); }
  }
  let queue = Promise.resolve();
  function transaction(operation) {
    const next = queue.then(() => locks?.request ? locks.request(browserStorageKey, async () => operation()) : operation());
    queue = next.catch(() => {});
    return next;
  }
  async function analyse(input) {
    validate('input', input);
    if (!input.subject.trim() || !input.body.trim()) throw new AppError('EMPTY_INPUT', 'Subject and email text must not be blank.');
    if (input.sample_id && !tickets.some(ticket => ticket.id === input.sample_id && ticket.subject === input.subject && ticket.body === input.body)) throw new AppError('SAMPLE_MISMATCH', 'Edited text must be labelled as a custom synthetic email.');
    const start = performance.now();
    const sources = retrieve(input, corpus);
    const output = await provider.generate({ input, sources });
    validateAnalysis(output, sources);
    const analysis = enforceRouting(output, riskFloor(input), sources);
    validateAnalysis(analysis, sources);
    const run = {
      id: cryptoApi.randomUUID(), created_at: new Date().toISOString(), input: structuredClone(input),
      mode: provider.mode, model: provider.model, knowledge_version: corpus.version, knowledge_hash: corpus.hash,
      prompt_version: provenance.prompt_version, prompt_hash: provenance.prompt_hash,
      status: 'ready', analysis, provider_analysis: output, provider_metadata: null, sources,
      checks: { structure: 'passed', citations: 'passed', content: 'human_review_required', safety: 'human_review_enforced' },
      storage: 'visitor_browser_only', cloud_edition: provenance.edition, error: null,
      duration_ms: Math.round(performance.now() - start), review_version: 0, review_status: 'pending'
    };
    const runs = readRuns();
    saveRuns([run, ...runs]);
    return run;
  }
  function reviewRun(id, value) {
    validate('review', value);
    const runs = readRuns();
    const run = runs.find(item => item.id === id);
    if (!run) throw new AppError('NOT_FOUND', 'Run not found.');
    if (run.review_version !== value.expected_version || run.review_status !== 'pending') throw new AppError('STALE_REVIEW', 'This run has already been reviewed. Reload its saved record.');
    if (value.action === 'approve' && !value.draft.trim()) throw new AppError('REVIEW_NOT_READY', 'Approval requires a non-empty draft.');
    if (value.knowledge_proposal.trim() && !value.note.trim()) throw new AppError('NOTE_REQUIRED', 'Add a review reason when proposing a knowledge change.');
    const review = {
      version: 1, at: new Date().toISOString(), action: value.action, status: reviewStatuses[value.action],
      draft: value.draft, note: value.note, edited: value.draft !== run.analysis.draft,
      knowledge_proposal: value.knowledge_proposal.trim() ? { status: 'pending_content_review', text: value.knowledge_proposal, knowledge_version: run.knowledge_version } : null
    };
    const updated = { ...run, review, review_status: review.status, review_version: 1 };
    saveRuns(runs.map(item => item.id === id ? updated : item));
    return updated;
  }
  return async function api(path, value) {
    if (path === '/api/bootstrap' && value === undefined) {
      await queue;
      return structuredClone({ mode: provider.mode, model: provider.model, cloud_demo: true, storage: 'visitor_browser_only', knowledge_version: corpus.version, prompt_version: provenance.prompt_version, articles: corpus.articles, tickets, runs: readRuns().slice(0, 30) });
    }
    if (path === '/api/analyse') return transaction(() => analyse(structuredClone(value)));
    const match = path.match(/^\/api\/runs\/([a-f0-9-]{36})\/review$/);
    if (match) return transaction(() => reviewRun(match[1], structuredClone(value)));
    throw new AppError('NOT_FOUND', 'This browser demo has no model, email-send or customer-system endpoint.');
  };
}
