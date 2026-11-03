import * as validators from '#share-validators';
import { corpus, contracts, prompts } from '#conversation-data';
import { ConversationService } from '../shared/conversation-service.mjs';
import { conversationRehearsalProvider } from '../shared/conversation.mjs';
import { conversationRoute } from '../server/conversation-http.mjs';
import { AppError } from '../server/errors.mjs';
const storageKey = 'support-lab-conversations-v2';
export class BrowserConversationStore {
  constructor(storage) { this.storage = storage; }
  read() {
    try {
      const value = JSON.parse(this.storage.getItem(storageKey) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(r => !r || !['case','mail','inbound','budget'].includes(r.kind) || !Number.isInteger(r.version) || !r.value)) throw Error();
      return value;
    } catch { throw new AppError('BROWSER_STORE_INVALID', 'Browser demonstration storage is unavailable or invalid. It was not erased.', 503); }
  }
  async get(kind,id) { return this.read()[`${kind}:${id}`] || null; }
  async list(kind) { return Object.values(this.read()).filter(r => r.kind === kind); }
  async put(kind,id,expected,value) {
    const all = this.read(), key = `${kind}:${id}`;
    if ((all[key]?.version ?? -1) !== expected) throw new AppError('STALE_CASE', 'Browser state changed; reload.', 409);
    all[key] = { kind,id,version:expected+1,value }; this.storage.setItem(storageKey,JSON.stringify(all));
  }
  async createInbound(eventId,mapping,record) {
    const all = this.read(); if (all[`inbound:${eventId}`]) throw new AppError('EVENT_DUPLICATE','Incoming event already reserved.',409);
    all[`inbound:${eventId}`] = {kind:'inbound',id:eventId,version:0,value:mapping}; all[`case:${record.id}`] = {kind:'case',id:record.id,version:0,value:record}; this.storage.setItem(storageKey,JSON.stringify(all));
  }
}
if (typeof window !== 'undefined' && location.pathname !== '/live') {
  const store = new BrowserConversationStore(window.localStorage);
  const validate = (name,value) => { if (!validators[name](value)) throw new AppError('SCHEMA_INVALID',`Invalid ${name} output.`,400); };
  const service = new ConversationService({ store, corpus, contracts, prompts, validate, provider:conversationRehearsalProvider() });
  let queue = Promise.resolve();
  window.supportConversationApi = (path,value) => {
    const run = async () => {
      const result = await conversationRoute(path,value === undefined ? 'GET':'POST',value,service);
      if (path === '/api/conversations' && value === undefined) return {...result,cloud:true,live_available:false};
      return result;
    };
    const next = queue.then(() => navigator.locks ? navigator.locks.request(storageKey,run) : run()); queue = next.catch(()=>{}); return next;
  };
}
