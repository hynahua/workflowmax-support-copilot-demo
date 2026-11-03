import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.mjs';
const queues = new Map();
export class ConversationStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'conversation-events.jsonl'); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.rows(); return this;
  }
  serial(fn) { const next = (queues.get(this.file) || Promise.resolve()).then(fn); queues.set(this.file, next.catch(() => {})); return next; }
  async rows() {
    let text;
    try { text = await readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }
    try {
      const rows = new Map();
      for (const line of text.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type !== 'snapshot_transaction' || !Array.isArray(event.changes) || !event.changes.length) throw Error();
        for (const row of event.changes) {
          if (!['case', 'inbound', 'mail', 'budget', 'session'].includes(row.kind) || typeof row.id !== 'string' || !Number.isSafeInteger(row.version) || !row.value || row.version !== (rows.get(`${row.kind}:${row.id}`)?.version ?? -1) + 1) throw Error();
          rows.set(`${row.kind}:${row.id}`, row);
        }
      }
      return rows;
    } catch { throw new AppError('STORE_CORRUPT', 'Conversation history is invalid. Preserve the file; it was not reset.', 503); }
  }
  async get(kind, id) { await queues.get(this.file); return (await this.rows()).get(`${kind}:${id}`) || null; }
  async list(kind) { await queues.get(this.file); return [...(await this.rows()).values()].filter(row => row.kind === kind); }
  async append(changes) {
    const handle = await open(this.file, 'a', 0o600);
    try { await handle.writeFile(JSON.stringify({ type: 'snapshot_transaction', at: new Date().toISOString(), changes }) + '\n'); await handle.sync(); } finally { await handle.close(); }
  }
  put(kind, id, expected, value) {
    return this.serial(async () => {
      const previous = (await this.rows()).get(`${kind}:${id}`);
      if ((previous?.version ?? -1) !== expected) throw new AppError('STALE_CASE', 'The saved state changed. Reload before continuing.', 409);
      await this.append([{ kind, id, version: expected + 1, value }]);
    });
  }
  initialiseModelSession(id, policy, child, parentGuard) {
    return this.serial(async () => {
      const rows = await this.rows();
      if (rows.has(`session:${id}`)) return;
      if (child) {
        const parent = rows.get(`budget:${parentGuard.id}`);
        const permitted = parentGuard.mode === 'successful' ? parent?.value.halt_code === 'AUTHORIZED_CASE_FINISHED' : parent?.value.halted !== true && parent?.value.requests === parent?.value.grant.max_requests;
        if (parent?.version !== parentGuard.version || !permitted) throw new AppError('STALE_CASE', 'The source allowance changed before its one-time continuation.', 409);
        if (rows.has(`budget:${child.id}`)) throw new AppError('STORE_CORRUPT', 'A continuation budget exists without its policy record.', 503);
      }
      const changes = [{kind:'session',id,version:0,value:policy}];
      if (child) changes.push({kind:'budget',id:child.id,version:0,value:child.value});
      await this.append(changes);
    });
  }
  reserveModelRequest(sessionId, sessionVersion, budgetId, expected, value) {
    return this.serial(async () => {
      const rows = await this.rows(), session = rows.get(`session:${sessionId}`);
      if (!session?.value.enabled || session.version !== sessionVersion) throw new AppError('MODEL_SESSION_OFF', 'The model switch changed before this request was accepted. Saved progress is preserved.', 409);
      const row = rows.get(`budget:${budgetId}`);
      if ((row?.version ?? -1) !== expected) throw new AppError('STALE_CASE', 'The request allowance changed. Refresh before continuing.', 409);
      await this.append([{kind:'budget',id:budgetId,version:expected+1,value}]);
    });
  }
  createInbound(eventId, mapping, record) {
    return this.serial(async () => {
      const rows = await this.rows();
      if (rows.has(`inbound:${eventId}`)) throw new AppError('EVENT_DUPLICATE', 'This incoming event has already been reserved. Reload the conversation.', 409);
      await this.append([{ kind: 'inbound', id: eventId, version: 0, value: mapping }, { kind: 'case', id: record.id, version: 0, value: record }]);
    });
  }
  async acquireProcessLease() {
    const path = join(this.directory, 'conversation-service.lock');
    try {
      const lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new AppError('STORE_BUSY', 'Inspect the existing service lock before restarting.', 503);
      try { process.kill(pid, 0); throw new AppError('STORE_BUSY', 'Another process already owns this conversation store.', 503); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await unlink(path); return this.acquireProcessLease();
    }
    this.releaseLease = async () => { if (await readFile(path, 'utf8').catch(() => '') === String(process.pid)) await unlink(path); };
  }
  async recover() {
    for (const row of await this.list('case')) {
      if (!row.value.busy) continue;
      const record = row.value;
      record.busy = false; record.revision++;
      record.status = record.status === 'sending' ? 'delivery_unknown' : 'human_required';
      record.reason = 'The service restarted during an operation. Inspect or reconcile; no automatic model call or resend was made.';
      if (record.deliveries.at(-1)?.status === 'sending') record.deliveries.at(-1).status = 'unknown';
      await this.put('case', row.id, row.version, record);
    }
  }
}
