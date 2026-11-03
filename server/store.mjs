import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate } from './validation.mjs';
import { AppError } from './errors.mjs';

export class EventStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'events.jsonl');
    this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.read();
    return this;
  }
  async read() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try {
      return raw.split('\n').filter(line => line.trim()).map(line => {
        const event = JSON.parse(line);
        if (!event.id || !event.run_id || !['run_created', 'review_recorded'].includes(event.type)) throw new Error('Invalid event');
        if (event.type === 'run_created' && (!event.run || event.run.id !== event.run_id || event.run.review_status !== 'pending' || event.run.review_version !== 0)) throw new Error('Invalid run event');
        if (event.type === 'review_recorded' && (!event.review || !['approved_not_sent', 'rejected', 'escalated'].includes(event.review.status) || !Number.isInteger(event.review.version))) throw new Error('Invalid review event');
        return event;
      });
    } catch {
      throw new AppError('STORE_CORRUPT', 'The local event file could not be validated. Preserve it for inspection; it has not been silently reset.', 503);
    }
  }
  serial(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async append(event) {
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  materialise(events) {
    const runs = new Map();
    for (const event of events) {
      if (event.type === 'run_created') runs.set(event.run_id, structuredClone(event.run));
      else {
        const run = runs.get(event.run_id);
        if (!run) throw new AppError('STORE_CORRUPT', 'A stored review is missing its original run.', 503);
        Object.assign(run, { review: event.review, review_status: event.review.status, review_version: event.review.version });
      }
    }
    return [...runs.values()].reverse();
  }
  async list() {
    await this.queue;
    return this.materialise(await this.read());
  }
  async get(id) { return (await this.list()).find(run => run.id === id) || null; }
  create(run) {
    return this.serial(async () => {
      await this.append({ id: randomUUID(), type: 'run_created', run_id: run.id, at: run.created_at, run });
      return run;
    });
  }
  review(id, value) {
    validate('review', value);
    return this.serial(async () => {
      const run = this.materialise(await this.read()).find(item => item.id === id);
      if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
      if (run.review_version !== value.expected_version || run.review_status !== 'pending') throw new AppError('STALE_REVIEW', 'This run has already been reviewed. Reload its saved record before taking another action.', 409);
      if (value.action === 'approve' && (run.status !== 'ready' || !value.draft.trim())) throw new AppError('REVIEW_NOT_READY', 'Only a usable, non-empty draft can be approved. Escalate or reject this run instead.');
      if (value.knowledge_proposal.trim() && !value.note.trim()) throw new AppError('NOTE_REQUIRED', 'Add a review reason when proposing a knowledge change.');
      const review = {
        version: run.review_version + 1, at: new Date().toISOString(), action: value.action,
        status: { approve: 'approved_not_sent', reject: 'rejected', escalate: 'escalated' }[value.action],
        draft: value.draft, note: value.note,
        edited: value.draft !== (run.analysis?.draft || ''),
        knowledge_proposal: value.knowledge_proposal.trim() ? { status: 'pending_content_review', text: value.knowledge_proposal, knowledge_version: run.knowledge_version } : null
      };
      await this.append({ id: randomUUID(), type: 'review_recorded', run_id: id, at: review.at, review });
      return { ...run, review, review_status: review.status, review_version: review.version };
    });
  }
}
