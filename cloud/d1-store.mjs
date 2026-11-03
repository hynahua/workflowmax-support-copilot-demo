import { AppError } from '../server/errors.mjs';
export class D1Store {
  constructor(db, namespace) { this.db = db; this.namespace = namespace; }
  async get(kind, id) {
    const row = await this.db.prepare('SELECT kind,id,version,value FROM support_state WHERE namespace=? AND kind=? AND id=?').bind(this.namespace, kind, id).first();
    return row ? { ...row, value: JSON.parse(row.value) } : null;
  }
  async list(kind) {
    const result = await this.db.prepare('SELECT kind,id,version,value FROM support_state WHERE namespace=? AND kind=? ORDER BY rowid DESC LIMIT 100').bind(this.namespace, kind).all();
    return result.results.map(row => ({ ...row, value: JSON.parse(row.value) }));
  }
  async listAttentionCases() {
    if (!this.namespace.startsWith('owner:')) throw new AppError('ATTENTION_FORBIDDEN', 'Attention records are limited to the signed-in owner conversation namespace.', 403);
    const result = await this.db.prepare("SELECT kind,id,version,value FROM support_state WHERE namespace=? AND kind='case' AND json_extract(value,'$.status') IN ('human_required','rejected','delivery_failed','delivery_unknown') ORDER BY rowid DESC").bind(this.namespace).all();
    return result.results.map(row => ({ ...row, value: JSON.parse(row.value) }));
  }
  async put(kind, id, expected, value) {
    const text = JSON.stringify(value);
    const statement = expected === -1
      ? this.db.prepare('INSERT OR IGNORE INTO support_state(namespace,kind,id,version,value) VALUES(?,?,?,0,?)').bind(this.namespace, kind, id, text)
      : this.db.prepare('UPDATE support_state SET version=version+1,value=? WHERE namespace=? AND kind=? AND id=? AND version=?').bind(text, this.namespace, kind, id, expected);
    const results = await this.db.batch([statement, this.db.prepare('INSERT INTO support_events(event_id,namespace,kind,item_id,version,value) SELECT ?,?,?,?,?,? WHERE changes()=1').bind(crypto.randomUUID(), this.namespace, kind, id, expected + 1, text)]);
    if (results[0].meta.changes !== 1) throw new AppError('STALE_CASE', 'The saved state changed. Reload before continuing.', 409);
  }
  async initialiseModelSession(id, policy, child, parentGuard) {
    const stateGuard = parentGuard?.mode === 'successful' ? "json_extract(value,'$.halt_code')='AUTHORIZED_CASE_FINISHED'" : "COALESCE(json_extract(value,'$.halted'),0)=0 AND json_extract(value,'$.requests')=json_extract(value,'$.grant.max_requests')";
    const condition = child ? ` AND EXISTS(SELECT 1 FROM support_state WHERE namespace=? AND kind='budget' AND id=? AND version=? AND ${stateGuard})` : '';
    const params = [this.namespace,'session',id,JSON.stringify(policy), ...(child?[this.namespace,parentGuard.id,parentGuard.version]:[])];
    const first = this.db.prepare(`INSERT OR IGNORE INTO support_state(namespace,kind,id,version,value) SELECT ?,?,?,0,? WHERE 1=1${condition}`).bind(...params);
    const audit = (kind,item,version,value) => this.db.prepare('INSERT INTO support_events(event_id,namespace,kind,item_id,version,value) SELECT ?,?,?,?,?,? WHERE changes()=1').bind(crypto.randomUUID(),this.namespace,kind,item,version,JSON.stringify(value));
    const statements = [first];
    if (child) statements.push(this.db.prepare('INSERT INTO support_state(namespace,kind,id,version,value) SELECT ?,?,?,0,? WHERE changes()=1').bind(this.namespace,'budget',child.id,JSON.stringify(child.value)),audit('budget',child.id,0,child.value));
    statements.push(audit('session',id,0,policy));
    const results = await this.db.batch(statements);
    if (results[0].meta.changes !== 1 && !await this.get('session',id)) throw new AppError('STALE_CASE','The source allowance changed before its one-time continuation.',409);
  }
  async reserveModelRequest(sessionId, sessionVersion, budgetId, expected, value) {
    const guard = "EXISTS(SELECT 1 FROM support_state WHERE namespace=? AND kind='session' AND id=? AND version=? AND json_extract(value,'$.enabled')=1)";
    const text=JSON.stringify(value);
    const first=expected===-1?this.db.prepare(`INSERT OR IGNORE INTO support_state(namespace,kind,id,version,value) SELECT ?,?,?,0,? WHERE ${guard}`).bind(this.namespace,'budget',budgetId,text,this.namespace,sessionId,sessionVersion):this.db.prepare(`UPDATE support_state SET version=version+1,value=? WHERE namespace=? AND kind='budget' AND id=? AND version=? AND ${guard}`).bind(text,this.namespace,budgetId,expected,this.namespace,sessionId,sessionVersion);
    const results=await this.db.batch([first,this.db.prepare('INSERT INTO support_events(event_id,namespace,kind,item_id,version,value) SELECT ?,?,?,?,?,? WHERE changes()=1').bind(crypto.randomUUID(),this.namespace,'budget',budgetId,expected+1,text)]);
    if(results[0].meta.changes!==1) {
      const session=await this.get('session',sessionId);
      if(!session?.value.enabled||session.version!==sessionVersion)throw new AppError('MODEL_SESSION_OFF','The model switch changed before this request was accepted. Saved progress is preserved.',409);
      throw new AppError('STALE_CASE','The request allowance changed. Refresh before continuing.',409);
    }
  }
  async createInbound(eventId, mapping, record) {
    try {
      await this.db.batch([
        this.db.prepare('INSERT INTO support_state(namespace,kind,id,version,value) VALUES(?,?,?,0,?)').bind(this.namespace, 'inbound', eventId, JSON.stringify(mapping)),
        this.db.prepare('INSERT INTO support_state(namespace,kind,id,version,value) VALUES(?,?,?,0,?)').bind(this.namespace, 'case', record.id, JSON.stringify(record)),
        this.db.prepare('INSERT INTO support_events(event_id,namespace,kind,item_id,version,value) VALUES(?,?,?,?,0,?)').bind(crypto.randomUUID(), this.namespace, 'case', record.id, JSON.stringify(record))
      ]);
    } catch { throw new AppError('EVENT_DUPLICATE', 'The incoming event could not be reserved. Reload before continuing.', 409); }
  }
}
