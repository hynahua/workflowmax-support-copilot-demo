import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { validate, validateAnalysis } from './validation.mjs';
import { retrieve } from './knowledge.mjs';
import { enforceRouting, riskFloor } from './routing.mjs';
import { AppError, publicError } from './errors.mjs';

const instructions = await readFile(new URL('../prompts/support-reviewer.md', import.meta.url), 'utf8');
export const promptVersion = 'support-reviewer-v1';
const promptHash = createHash('sha256').update(instructions).digest('hex');

export async function analyse(input, { corpus, provider, timeoutMs = 20000 }) {
  validate('input', input);
  if (!input.subject.trim() || !input.body.trim()) throw new AppError('EMPTY_INPUT', 'Subject and email text must not be blank.', 400);
  const start = performance.now();
  const sources = retrieve(input, corpus);
  const run = {
    id: randomUUID(), created_at: new Date().toISOString(), input: structuredClone(input),
    mode: provider.mode, model: provider.model,
    knowledge_version: corpus.version, knowledge_hash: corpus.hash,
    prompt_version: promptVersion, prompt_hash: promptHash,
    status: 'blocked', analysis: null, provider_analysis: null, provider_metadata: null, sources,
    checks: { structure: 'not_run', citations: 'not_run', content: 'human_review_required', safety: 'not_run' },
    error: null, duration_ms: 0, review_version: 0, review_status: 'pending'
  };
  const controller = new AbortController();
  let timeout;
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => provider.generate({ input: structuredClone(input), sources: structuredClone(sources), instructions, signal: controller.signal, onMetadata: metadata => { run.provider_metadata = metadata; } })),
      new Promise((resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new AppError('PROVIDER_TIMEOUT', 'The provider timed out. No product answer has been approved; retry or hand this request to a person.', 503)); }, timeoutMs); })
    ]);
    validateAnalysis(output, sources);
    run.checks.structure = 'passed';
    run.checks.citations = 'passed';
    run.provider_analysis = structuredClone(output);
    run.analysis = enforceRouting(output, riskFloor(input), sources);
    validateAnalysis(run.analysis, sources);
    run.checks.safety = 'human_review_enforced';
    run.status = 'ready';
  } catch (error) {
    run.error = error instanceof AppError ? publicError(error) : { code: 'PROVIDER_FAILED', message: 'The provider did not return a usable response. No product answer has been approved. Try again or hand this request to a person.' };
  } finally { clearTimeout(timeout); }
  run.duration_ms = Math.round(performance.now() - start);
  return run;
}
