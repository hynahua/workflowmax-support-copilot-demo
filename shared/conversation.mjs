import { riskFloor, intentLabels } from '../server/routing.mjs';
import { retrieve } from './knowledge.mjs';
import { AppError } from '../server/errors.mjs';

export const workflowVersion = 'conversation-v2-customer-reply-v2';
export const questions = Object.freeze({
  screen: 'Are you using the weekly timesheet view, quick time entry, or another screen?',
  task: 'What task are you trying to complete?',
  error_message: 'What error message do you see? Please remove personal details and credentials.'
});
export function sensitive(text) {
  return /\bsk-(?:proj-)?[\w-]{12,}|\bBearer\s+[\w.-]{8,}|\b(?:password|api[_ -]?key|secret|token)\s*[:=]\s*\S+/i.test(text);
}
export function assertSynthetic(value) {
  if (value.synthetic !== true) throw new AppError('SYNTHETIC_ONLY', 'Only synthetic demonstration data is allowed.', 400);
  if (sensitive(JSON.stringify(value))) throw new AppError('SENSITIVE_INPUT', 'Remove credentials before using this synthetic demonstration.', 400);
}
export function explicitHuman(text) {
  const positive = text.replace(/\b(?:i\s+)?(?:do not|don't|dont|no longer)\s+(?:need|want|require)\s+(?:(?:to\s+)?(?:speak|talk)\s+(?:to|with)\s+)?(?:(?:a|an|any)\s+)?(?:human|person|agent|representative)(?:\s+(?:support|help))?/gi, '')
    .replace(/(?:不需要|不用|不要)(?:转|接|联系)?人工/g, '');
  return /\b(?:connect|transfer|escalate|speak|talk)(?:\s+\w+){0,4}\s+(?:human|person|agent|representative)\b|\b(?:want|need|request)\s+(?:(?:a|an)\s+)?(?:human|person|agent|representative)\b|(?:请|需要|要求).{0,6}(?:接|转|联系)?人工/i.test(positive);
}
export function mergedInput(record) {
  return { subject: record.subject, body: record.messages.map(m => `${m.role}: ${m.text}`).join('\n'), synthetic: true, sample_id: null };
}
function assertOutput(validate, name, output) {
  validate(name, output);
  if (sensitive(JSON.stringify(output))) throw new AppError('UNSAFE_OUTPUT', 'The generated output contains sensitive-looking content; hand off to a person.');
}
function checkedClarification(output, record) {
  const field = output.missing_information[0];
  if (output.missing_information.length !== 1 || output.clarification !== questions[field] || record.messages.some(m => m.role === 'assistant' && m.text === output.clarification)) {
    throw new AppError('CLARIFICATION_UNSAFE', 'The clarification is outside approved question patterns or repeats a previous question.');
  }
  if (record.clarification_count >= 2) throw new AppError('CLARIFICATION_LIMIT', 'Two clarification rounds have been reached. A person must continue.');
  return output.clarification;
}
export function checkDraft(output, sources) {
  const ids = new Set(sources.map(s => s.id));
  const inline = [...output.draft.matchAll(/\[(K-\d{3})\]/g)].map(m => m[1]);
  if (!output.draft.trim() || !output.citation_ids.length || output.citation_ids.some(id => !ids.has(id)) || inline.some(id => !output.citation_ids.includes(id)) || output.citation_ids.some(id => !inline.includes(id))) {
    throw new AppError('UNKNOWN_CITATION', 'Use only retrieved source IDs; each citation_ids entry needs a matching inline [K-000] citation and vice versa.');
  }
  const allowed = new Set(sources.map(s => s.url));
  const urls = output.draft.match(/https?:\/\/[^\s<>\])]+/g) || [];
  if (urls.some(url => !allowed.has(url.replace(/[.,;]$/, '')))) throw new AppError('UNKNOWN_CITATION', 'Only URLs supplied by the retrieved sources may appear.');
  if (/\b(?:i|we) (?:have |already )?(?:saved|sent|changed|verified|checked|enabled|unlocked)\b/i.test(output.draft)) throw new AppError('UNVERIFIED_ACTION', 'The draft claims an account action or verification the application did not perform.');
}
export function customerSourceLinks(draft, citationIds, sources) {
  const links = [...new Set(citationIds)].map(id => sources.find(source => source.id === id))
    .filter(source => source && !(draft.includes(source.url) && draft.includes(source.title)));
  const customerText = draft.replace(/\s*\[K-\d{3}\]/g, '').trim();
  return {
    draft: links.length ? `${customerText}\n\nFurther guidance:\n${links.map(source => `${source.title}: ${source.url}`).join('\n')}` : customerText,
    added_source_ids: links.map(source => source.id),
    removed_internal_ids: [...new Set([...draft.matchAll(/\[(K-\d{3})\]/g)].map(match => match[1]))]
  };
}
function handoff(record, reason) { record.status = 'human_required'; record.reason = reason; record.draft = ''; return record; }
function safeFailure(error) {
  return error instanceof AppError ? { code: error.code, message: error.message } : { code: 'PROVIDER_FAILED', message: 'The operation failed. A person must inspect the context; no answer is approved.' };
}

// Providers propose; this fixed application workflow controls retrieval, repair and transport.
export async function advance(record, { provider, corpus, validate, contracts, prompts, timeoutMs = 20000, resume = false }) {
  const input = mergedInput(record);
  if (!resume) { record.sources = []; record.draft = ''; }
  record.error = null;
  let activePhase = resume ? record.resume_stage : 'triage';
  record.mode = provider.mode; record.model = provider.model;
  record.provenance = { workflow: workflowVersion, knowledge_version: corpus.version, knowledge_hash: corpus.hash, prompts: prompts.provenance, schemas: contracts.provenance };
  const call = async (phase, feedback = []) => {
    activePhase = phase;
    const controller = new AbortController(); let timer;
    const attempt = { phase, attempt: record.attempts.filter(a => a.turn === record.turn && a.phase === phase && a.provider_requested !== false).length + 1, provider_requested: !provider.requiresAdmission, turn: record.turn, feedback, output: null, metadata: null, error: null };
    record.attempts.push(attempt);
    try {
      const result = await Promise.race([
        provider.generate({ phase, contract: contracts[phase], input, context: record.messages, triage: record.triage, sources: record.sources, instructions: prompts[phase], feedback, signal: controller.signal, onDispatch: () => { attempt.provider_requested = true; }, onMetadata: m => { attempt.metadata = m; }, onOutput: value => { if (!sensitive(JSON.stringify(value))) attempt.output = structuredClone(value); } }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AppError('PROVIDER_TIMEOUT', 'The model timed out. Do not automatically repeat this request.', 503)); }, timeoutMs); })
      ]);
      if (!sensitive(JSON.stringify(result))) attempt.output = structuredClone(result);
      return result;
    } catch (error) { attempt.error = safeFailure(error); throw error; }
    finally { clearTimeout(timer); }
  };
  try {
    if (!resume || record.resume_stage !== 'draft') {
    const original = await call('triage');
    assertOutput(validate, 'triage', original);
    const flags = [...new Set([...original.risk_flags, ...riskFloor(input)])];
    const customerText = record.messages.filter(m => m.role === 'customer').map(m => m.text).join('\n');
    const directHuman = explicitHuman(customerText);
    const negatedHuman = /(?:do not|don't|dont|no longer)\s+(?:need|want|require).{0,35}(?:human|person|agent|representative)|\bno (?:human|person|agent|representative)(?: is)? (?:needed|required)\b|(?:不需要|不用|不要)(?:转|接|联系)?人工/i.test(customerText);
    const requested = directHuman || (!negatedHuman && original.human_requested);
    record.triage = { ...structuredClone(original), intents: [...new Set([...original.intents, ...intentLabels(input, flags).filter(label => label !== 'unknown')])], risk_flags: flags, human_requested: requested, decision: requested || flags.length ? 'handoff' : negatedHuman && original.human_requested && original.decision === 'handoff' ? 'retrieve' : original.decision };
    record.overrides.push({ turn: record.turn, original: structuredClone(original), effective: structuredClone(record.triage) });
    if (requested || flags.length || record.triage.decision === 'handoff' || original.intents.includes('unknown')) return handoff(record, requested ? 'The customer explicitly requested a person.' : `Triage requires a person: ${flags.join(', ') || original.reason}`);
    if (original.decision === 'clarify') { record.pending_question = checkedClarification(original, record); record.status = 'clarification_ready'; return record; }
    if (original.missing_information.length) return handoff(record, 'Triage contains unresolved customer information.');
    const query = { ...input, body: `${input.body}\nRetrieval directions: ${original.search_queries.join(' ')}\nIntents: ${original.intents.join(' ')}` };
    record.sources = retrieve(query, corpus);
    if (!record.sources.length) return handoff(record, 'No relevant evidence in the approved collection. Consult a person or an additional authorized source; this does not establish whether the product supports the feature.');
    }
    const spent = record.attempts.filter(a => a.turn === record.turn && a.phase === 'draft' && a.provider_requested !== false).length;
    if (spent >= 4) throw new AppError('OUTPUT_REPAIR_EXHAUSTED', 'The four draft attempts have been used. A person must continue.');
    for (let attempt = spent; attempt < 4; attempt++) {
      let output;
      try {
        const previous = record.attempts.findLast(a => a.turn === record.turn && a.phase === 'draft' && a.provider_requested !== false);
        const feedback = attempt ? [previous?.validation_error || previous?.error?.message || 'Return valid JSON matching the draft schema.'] : [];
        output = await call('draft', feedback);
        assertOutput(validate, 'draft', output);
        if (output.risk_flags.length || output.decision === 'handoff') return handoff(record, `Evidence assessment requires a person: ${output.reason}`);
        if (output.decision === 'clarify') { record.pending_question = checkedClarification(output, record); record.status = 'clarification_ready'; return record; }
        if (output.missing_information.length || output.clarification) return handoff(record, 'Draft has unresolved information or conflicting output fields.');
        checkDraft(output, record.sources);
        // Add only known cited links before human review; never transform approved delivery text.
        const customerReply = customerSourceLinks(output.draft, output.citation_ids, record.sources);
        assertOutput(validate, 'draft', { ...output, draft: customerReply.draft });
        if (customerReply.added_source_ids.length || customerReply.removed_internal_ids.length) record.overrides.push({ turn: record.turn, phase: 'draft', rule: 'customer_source_links_v2', added_source_ids: customerReply.added_source_ids, removed_internal_ids: customerReply.removed_internal_ids });
        record.draft = customerReply.draft; record.citation_ids = output.citation_ids; record.reason = output.reason;
        record.status = 'awaiting_review'; return record;
      } catch (error) {
        const repairable = ['SCHEMA_INVALID', 'UNKNOWN_CITATION', 'MODEL_OUTPUT_JSON', 'UNVERIFIED_ACTION'].includes(error.code);
        record.attempts.at(-1).validation_error = safeFailure(error).message;
        if (!repairable || attempt === 3) throw error;
      }
    }
  } catch (error) {
    record.error = safeFailure(error);
    if (error.code === 'MODEL_SESSION_OFF') { record.status = 'model_paused'; record.resume_stage = activePhase; record.reason = 'Model is OFF. Completed steps and evidence are saved. Turn the model on, then explicitly resume the pending step; no request is repeated automatically.'; return record; }
    return handoff(record, record.error.message);
  }
}

export function conversationRehearsalProvider() {
  return { mode: 'rules_rehearsal', model: 'deterministic-conversation-v2', async generate({ phase, input, sources, context }) {
    const risk_flags = riskFloor(input);
    if (phase === 'triage') {
      const human_requested = explicitHuman(context.filter(m => m.role === 'customer').map(m => m.text).join('\n'));
      const missing = /(?:auto.{0,15}sav|sav.{0,15}auto|save it myself)/i.test(input.body) && !/customer:.*(?:weekly|quick time|another screen)/i.test(input.body);
      return { summary: input.subject, intents: intentLabels(input, risk_flags), risk_flags, reason: 'Deterministic rehearsal, not model evaluation.', human_requested, decision: human_requested || risk_flags.length ? 'handoff' : missing ? 'clarify' : 'retrieve', missing_information: missing ? ['screen'] : [], clarification: missing ? questions.screen : '', search_queries: [input.subject, /time|hours|save/i.test(input.body) ? 'timesheet weekly save' : input.subject] };
    }
    const source = sources.find(s => s.id === 'K-002') || sources[0];
    const weekly = source.id === 'K-002' && /customer:.*weekly/i.test(input.body);
    return { summary: input.subject, risk_flags, reason: 'Rehearsal only; a person must verify evidence and applicability.', decision: 'draft', missing_information: [], clarification: '', draft: weekly ? `Hi Maya, thanks for confirming. The weekly timesheet view does not save automatically, so please use its save control. Weekly entry requires your organisation's Weekly Timesheet Entry setting to be enabled; I have not checked your settings or whether the four hours were saved. See About timesheets [K-002].` : `Thanks for your question. ${source.facts[0]} ${source.conditions.join(' ')} [${source.id}]`, citation_ids: [source.id] };
  } };
}
