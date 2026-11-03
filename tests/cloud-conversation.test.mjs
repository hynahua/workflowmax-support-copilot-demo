import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { conversationConfig } from '../server/conversation-config.mjs';
import { loadKnowledge } from '../server/knowledge.mjs';
import { D1Store } from '../cloud/d1-store.mjs';
const { contracts, prompts } = await conversationConfig(), corpus = await loadKnowledge();
const ajv = new Ajv2020({strict:true,code:{source:true,esm:true}});
for(const phase of ['triage','draft'])ajv.addSchema(contracts[phase]);
const validators = standaloneCode(ajv,{triage:'triage',draft:'draft'});
async function compiled(entry) {
  const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,platform:'browser',format:'esm',plugins:[{name:'test-data',setup(plugin){
    plugin.onResolve({filter:/^#(cloud-data|share-validators|conversation-data)$/},args=>({path:args.path,namespace:'test-data'}));
    plugin.onLoad({filter:/.*/,namespace:'test-data'},args=>({contents:args.path==='#share-validators'?validators:`export const assets={};export const corpus=${JSON.stringify(corpus)};export const contracts=${JSON.stringify(contracts)};export const prompts=${JSON.stringify(prompts)};`,resolveDir:process.cwd(),loader:'js'}));
  }}]});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const worker=(await compiled('../cloud/worker.mjs')).default;
const BrowserStore=(await compiled('../share/conversation-browser.mjs')).BrowserConversationStore;
let DatabaseSync; try { ({DatabaseSync}=await import('node:sqlite')); } catch {}
function sqliteD1(t) {
  if(!DatabaseSync){t.skip('Node built-in SQLite is unavailable on this runtime; cloud SQL checks require Node 22.13+ or Node 24.');return null;}
  const db=new DatabaseSync(':memory:');let queue=Promise.resolve();t.after(()=>db.close());
  return {db,prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};return statement;},batch(statements){const next=queue.then(async()=>{db.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}});queue=next.catch(()=>{});return next;}};
}
async function migrated(t){const d1=sqliteD1(t);if(d1)d1.db.exec(await readFile(new URL('../cloud/drizzle/0000_support_state.sql',import.meta.url),'utf8'));return d1;}
const req=(path,options={})=>new Request('https://synthetic.example'+path,options);
const identity={'oai-authenticated-user-id':'owner-scoped-id','oai-authenticated-user-email':'owner@example.test'};
test('retired cloud cleanup returns404 to the owner and cannot change records, events or allowances',async t=>{
  const d1=await migrated(t);if(!d1)return;const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test'};
  const store=new D1Store(d1,'owner:owner-scoped-id'),budget=new D1Store(d1,'global-live-budget');
  for(const [id,created_at]of[['older-test','2026-11-01T01:00:00.000Z'],['keep-mia','2026-11-03T01:00:00.000Z']]){
    await store.createInbound(`in-${id}`,{case_id:id,fingerprint:'synthetic-fixture'},{id,created_at,revision:0,synthetic:true,busy:false,status:'sent_test',subject:id,deliveries:[{id:`${id}-answer`,transport:'test_only'}]});
    await store.put('mail',`${id}-answer`,-1,{body:`Synthetic ${id}`,transport:'test_only',status:'sent_test'});
  }
  await budget.put('budget','retained-allowance',-1,{requests:23,reserved_usd:0.0575});
  await budget.put('session','retained-allowance',-1,{enabled:true});
  const snapshot=()=>JSON.stringify({state:d1.db.prepare('SELECT * FROM support_state ORDER BY namespace,kind,id').all(),events:d1.db.prepare('SELECT * FROM support_events ORDER BY event_id').all()});
  const before=snapshot(),originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Retired cleanup must not request a model');};
  try{
    for(const path of ['/api/live/conversations/cleanup-preview','/api/live/conversations/cleanup']){
      for(const [headers,origin,status]of[[identity,'https://synthetic.example',404],[{},'https://synthetic.example',401],[{...identity,'oai-authenticated-user-email':'other@example.test'},'https://synthetic.example',403],[identity,'https://foreign.example',403]]){
        const response=await worker.fetch(req(path,{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({keep_case_id:'keep-mia',expected_revision:0,confirmed:true,preview_token:'a'.repeat(64)})}),env);
        assert.equal(response.status,status);if(status===404)assert.equal((await response.json()).error.code,'NOT_FOUND');
        assert.equal(snapshot(),before,'Retired endpoints must not change cases, inbound mappings, TEST mail, events, budget or session.');
      }
    }
    assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch;}
});
test('public/anonymous and wrong visitor identities cannot read/write the paid API',async()=>{
  for(const [headers,status,access] of [[{},401,'signed_out'],[{...identity,'oai-authenticated-user-email':'viewer@example.test'},403,'not_authorized'],[{'oai-authenticated-user-email':'owner@example.test'},401,'signed_out']]){
    const response=await worker.fetch(req('/api/live/conversations',{headers}),{LIVE_OPERATOR_EMAIL:'owner@example.test'});assert.equal(response.status,status);const value=await response.json();assert.equal(value.access.status,access);assert.doesNotMatch(JSON.stringify(value),/sk-|owner@example/);
  }
});
test('live secret and grant absence stays explicit, GET does not call a model',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const response=await worker.fetch(req('/api/live/conversations',{headers:identity}),{DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test'});
  assert.equal(response.status,200);const value=await response.json();assert.equal(value.mode,'not_connected');assert.equal(value.live_available,false);assert.deepEqual(value.access,{status:'signed_in',role:'owner'});assert.equal(value.budget.status,'no_active_grant');assert.deepEqual(value.conversations,[]);
});
test('cloud rejects foreign origin, malformed data and oversized input before a provider request',async t=>{
  const d1=await migrated(t);if(!d1)return;const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test'};
  for(const [origin,text,status]of[['https://wrong.example','{}',403],['https://synthetic.example','{',400],['https://synthetic.example','x'.repeat(16385),413]]){
    const response=await worker.fetch(req('/api/live/conversations',{method:'POST',headers:{...identity,Origin:origin,'Content-Type':'application/json'},body:text}),env);assert.equal(response.status,status);
  }
});
test('actual D1 SQL preserves CAS, append-only events, namespaces and atomic inbound deduplication',async t=>{
  const d1=await migrated(t);if(!d1)return;const a=new D1Store(d1,'owner:a'),b=new D1Store(d1,'owner:b');
  await a.put('budget','grant',-1,{requests:1});assert.equal((await a.get('budget','grant')).value.requests,1);assert.equal(await b.get('budget','grant'),null);
  await assert.rejects(a.put('budget','grant',-1,{requests:0}),{code:'STALE_CASE'});
  assert.equal(d1.db.prepare('SELECT COUNT(*) AS n FROM support_events').get().n,1);
  await a.put('budget','grant',0,{requests:2});assert.equal((await a.get('budget','grant')).version,1);
  await a.createInbound('event',{case_id:'case'},{id:'case',revision:0});
  await assert.rejects(a.createInbound('event',{case_id:'other'},{id:'other',revision:0}),{code:'EVENT_DUPLICATE'});assert.equal(await a.get('case','other'),null);assert.equal((await a.list('case')).length,1);
});
test('owner attention cases remain available beyond recent history without duplicates, cross-owner data or model calls',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const owner=new D1Store(d1,'owner:owner-scoped-id'),other=new D1Store(d1,'owner:other'),budget=new D1Store(d1,'global-live-budget');
  const add=async(store,id,status,kind='case')=>store.put(kind,id,-1,{id,revision:0,busy:false,status,subject:id,deliveries:[],created_at:'2026-11-01T01:00:00.000Z'});
  const attention=['human_required','rejected','delivery_failed','delivery_unknown'];
  for(const status of attention)await add(owner,`older-${status}`,status);
  await add(owner,'older-normal-review','awaiting_review');await add(owner,'older-paused','model_paused');
  for(let i=0;i<105;i++)await add(owner,`recent-completed-${i}`,'sent_test');
  await add(owner,'recent-handoff','human_required');
  await add(owner,'not-a-case','human_required','budget');await add(other,'other-handoff','human_required');await add(budget,'global-handoff','human_required');
  await budget.put('budget','unchanged-allowance',-1,{requests:7});
  const snapshot=()=>JSON.stringify({state:d1.db.prepare('SELECT * FROM support_state ORDER BY namespace,kind,id').all(),events:d1.db.prepare('SELECT * FROM support_events ORDER BY event_id').all()});
  const before=snapshot();assert.equal((await owner.list('case')).length,100);
  assert.deepEqual(new Set((await owner.listAttentionCases()).map(row=>row.id)),new Set(['recent-handoff',...attention.map(status=>`older-${status}`)]));
  await assert.rejects(budget.listAttentionCases(),{code:'ATTENTION_FORBIDDEN'});
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Attention navigation must not call a provider');};
  try{
    const response=await worker.fetch(req('/api/live/conversations',{headers:identity}),{DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test'});
    assert.equal(response.status,200);const {conversations}=await response.json();
    const ids=conversations.map(record=>record.id);assert.equal(ids.length,104);assert.equal(new Set(ids).size,ids.length);
    for(const status of attention)assert.ok(ids.includes(`older-${status}`));
    for(const id of ['older-normal-review','older-paused','not-a-case','other-handoff','global-handoff'])assert.ok(!ids.includes(id));
    assert.equal(ids.filter(id=>id==='recent-handoff').length,1);assert.equal(calls,0);assert.equal(snapshot(),before);
  }finally{globalThis.fetch=originalFetch;}
});
test('browser v2 storage keeps visitor isolation, CAS and corrupt-history failure visible',async()=>{
  const memory=()=>{let value=null;return {getItem:()=>value,setItem:(_,next)=>{value=next;}};};const storage=memory(),a=new BrowserStore(storage),b=new BrowserStore(memory());
  await a.put('case','case',-1,{synthetic:true});assert.equal((await new BrowserStore(storage).get('case','case')).value.synthetic,true);assert.equal(await b.get('case','case'),null);
  await assert.rejects(a.put('case','case',-1,{}),{code:'STALE_CASE'});storage.setItem('x','bad json');await assert.rejects(a.get('case','case'),{code:'BROWSER_STORE_INVALID'});assert.equal(storage.getItem(),'bad json');
});

test('cloud operation leases preserve active work and recover interrupted work without paid calls or resend',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const {ConversationService}=await import('../shared/conversation-service.mjs');
  const {unconfiguredProvider}=await import('../server/providers.mjs');
  const {validate}=await conversationConfig();const store=new D1Store(d1,'owner:lease');
  const service=new ConversationService({store,corpus,contracts,prompts,validate,provider:unconfiguredProvider()});
  const record=await service.create({subject:'Synthetic lease case',body:'Please connect me to a person.',synthetic:true,event_id:'lease'});
  record.busy=true;record.status='processing';record.operation_started_at=new Date().toISOString();await service.persist(record,record.revision);
  const active=await service.get(record.id);assert.equal(active.status,'processing');assert.equal(active.busy,true);
  active.operation_started_at=new Date(Date.now()-121000).toISOString();await service.persist(active,active.revision);
  let recovered=await service.get(record.id);assert.equal(recovered.status,'human_required');assert.equal(recovered.busy,false);assert.equal(recovered.attempts.length,1);
  recovered.busy=true;recovered.status='sending';recovered.operation_started_at=new Date(Date.now()-121000).toISOString();recovered.deliveries=[{id:'unknown-send',status:'sending',kind:'answer'}];await service.persist(recovered,recovered.revision);
  recovered=(await service.list())[0];assert.equal(recovered.status,'delivery_unknown');assert.equal(recovered.deliveries[0].status,'unknown');
  await assert.rejects(service.reconcile(record.id,{expected_revision:recovered.revision}),{code:'DELIVERY_UNRESOLVED'});assert.equal((await store.list('mail')).length,0);
});

test('Worker/D1 manual session completes a case without closing the shared allowance',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const {conversationRehearsalProvider}=await import('../shared/conversation.mjs');const rules=conversationRehearsalProvider();const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');if(options.redirect==='error')throw new TypeError('Unsupported redirect mode in Workers');assert.equal(options.redirect,'manual');
    const payload=JSON.parse(options.body),data=JSON.parse(payload.input[0].content[0].text);
    const output=await rules.generate({phase:data.phase,input:data.synthetic_email,context:data.conversation,sources:data.retrieved_evidence});
    return new Response(JSON.stringify({id:`resp_mock_${calls}`,model:'gpt-6-luna',status:'completed',usage:{input_tokens:10,output_tokens:10},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));
  };
  try{
    const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test',OPENAI_API_KEY:'fake-only-placeholder',LIVE_APPROVED_PLAN:JSON.stringify({id:'cloud-mock-one-case',max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+60000).toISOString()})};
    const post=async(path,value)=>{const response=await worker.fetch(req(path,{method:'POST',headers:{...identity,Origin:'https://synthetic.example','Content-Type':'application/json'},body:JSON.stringify(value)}),env);assert.equal(response.status,200);return response.json();};
    const off=await(await worker.fetch(req('/api/live/model-session',{headers:identity}),env)).json();
    await post('/api/live/model-session',{enabled:true,expected_version:off.control_version});
    let record=await post('/api/live/conversations',{subject:'Does my time save automatically?',body:"Hi, I've entered four hours against the Riverside Café website project. Does this save automatically, or do I need to save it myself?",synthetic:true,event_id:'cloud-mock-initial'});assert.equal(record.status,'awaiting_reply');
    record=await post(`/api/live/conversations/${record.id}/reply`,{body:"I'm using the weekly timesheet view.",synthetic:true,event_id:'cloud-mock-reply',expected_revision:record.revision});assert.equal(record.status,'awaiting_review');assert.equal(calls,3);
    const availability=await(await worker.fetch(req('/api/live/conversations',{headers:identity}),env)).json();assert.equal(availability.generation_enabled,true);assert.equal(availability.budget.status,'ready');
    await post('/api/live/model-session',{enabled:false,expected_version:availability.budget.control_version});
    record=await post(`/api/live/conversations/${record.id}/review`,{expected_revision:record.revision,action:'approve',reviewer:'Assistant unit-test simulation only',draft:record.draft,note:'K-002 checked in mock test.',confirmed:true});
    record=await post(`/api/live/conversations/${record.id}/send`,{expected_revision:record.revision,approved_hash:record.approval.hash});assert.equal(record.status,'sent_test');assert.equal(record.approval.hash,record.deliveries.at(-1).hash);assert.equal(calls,3);
  }finally{globalThis.fetch=originalFetch;}
});

test('owner identity and saved records remain available independently of a closed or absent test budget',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const store=new D1Store(d1,'owner:owner-scoped-id');
  await store.createInbound('saved-event',{case_id:'saved-case'},{id:'saved-case',revision:0,busy:false,status:'sent_test',mode:'live_ai'});
  const grant={id:'closed-identity-test',max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+60000).toISOString()};
  await new D1Store(d1,'global-live-budget').put('budget',grant.id,-1,{grant,requests:3,reserved_usd:0.0075,halted:true,halt_code:'AUTHORIZED_CASE_FINISHED'});
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('A status read must not call a provider');};
  try{
    for(const [extra,expected]of[[{OPENAI_API_KEY:'fake-only-placeholder'},'no_active_grant'],[{OPENAI_API_KEY:'fake-only-placeholder',LIVE_APPROVED_PLAN:JSON.stringify(grant)},'closed'],[{LIVE_APPROVED_PLAN:JSON.stringify(grant)},'closed']]){
      const response=await worker.fetch(req('/api/live/conversations',{headers:identity}),{DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test',...extra});
      assert.equal(response.status,200);const value=await response.json();assert.deepEqual(value.access,{status:'signed_in',role:'owner'});assert.equal(value.generation_enabled,false);assert.equal(value.budget.status,expected);assert.equal(value.conversations[0].status,'sent_test');
      assert.doesNotMatch(JSON.stringify(value),/fake-only-placeholder|owner@example|OPENAI_API_KEY|secret_present|key_valid/);
    }
    assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('model switch requires owner identity and same-origin JSON; switching itself makes no provider call',async t=>{
  const d1=await migrated(t);if(!d1)return;const grant={id:'switch-auth',max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+60000).toISOString()};const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test',OPENAI_API_KEY:'fake-only-placeholder',LIVE_APPROVED_PLAN:JSON.stringify(grant)};
  for(const [headers,status]of[[{},401],[{...identity,'oai-authenticated-user-email':'viewer@example.test'},403]]){const r=await worker.fetch(req('/api/live/model-session',{method:'POST',headers:{...headers,Origin:'https://synthetic.example','Content-Type':'application/json'},body:'{"enabled":true,"expected_version":0}'}),env);assert.equal(r.status,status);}
  const off=await(await worker.fetch(req('/api/live/model-session',{headers:identity}),env)).json();assert.equal(off.status,'off');
  const foreign=await worker.fetch(req('/api/live/model-session',{method:'POST',headers:{...identity,Origin:'https://wrong.example','Content-Type':'application/json'},body:JSON.stringify({enabled:true,expected_version:off.control_version})}),env);assert.equal(foreign.status,403);
  const on=await worker.fetch(req('/api/live/model-session',{method:'POST',headers:{...identity,Origin:'https://synthetic.example','Content-Type':'application/json'},body:JSON.stringify({enabled:true,expected_version:off.control_version})}),env);assert.equal(on.status,200);assert.equal((await on.json()).requests_reserved,0);assert.equal((await new D1Store(d1,'global-live-budget').list('budget')).length,0);
});
test('D1 continuation is atomic, single-claim and its switch/version guards budget dispatch',async t=>{
  const d1=await migrated(t);if(!d1)return;const {boundedLiveProvider}=await import('../shared/live-budget.mjs');const store=new D1Store(d1,'pool');const grant={id:'approved-success-parent',max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+60000).toISOString()};const parent={grant,requests:3,reserved_usd:0.0075,halted:true,halt_code:'AUTHORIZED_CASE_FINISHED'};await store.put('budget',grant.id,-1,parent);
  let calls=0;const base={mode:'live_ai',model:'mock-only',generate:async()=>{calls++;return{};}};const a=boundedLiveProvider(base,{store,grant,allowContinuation:true}),b=boundedLiveProvider(base,{store,grant,allowContinuation:true});const values=await Promise.all([a.availability(),b.availability()]);assert.ok(values.every(v=>v.requests_reserved===3&&v.remaining_requests===3));assert.equal((await store.list('budget')).length,2);assert.deepEqual((await store.get('budget',grant.id)).value,parent);
  const version=values[0].control_version;const switches=await Promise.allSettled([a.setEnabled({enabled:true,expected_version:version}),b.setEnabled({enabled:true,expected_version:version})]);assert.equal(switches.filter(v=>v.status==='fulfilled').length,1);
  const before=await a.availability();const originalReserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{await a.setEnabled({enabled:false,expected_version:before.control_version});return originalReserve(...args);};await assert.rejects(a.generate({instructions:'Synthetic request'}),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);assert.equal((await a.availability()).requests_reserved,3);
});

test('Worker practice grant initializes inherited 6/1000 once in D1 and never changes old state',async t=>{
  const d1=await migrated(t);if(!d1)return;const store=new D1Store(d1,'global-live-budget');const oldId='demo-parent-session--manual-continuation';const oldGrant={id:'demo-parent-session',max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+60000).toISOString()};const old={grant:oldGrant,requests:6,reserved_usd:0.015};await store.put('budget',oldId,-1,old);await store.put('session',oldGrant.id,-1,{enabled:true,budget_id:oldId});
  const grant={id:'demo-practice-session',max_requests:1000,max_usd:10,expires_at:new Date(Date.now()+60000).toISOString()};const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test',OPENAI_API_KEY:'fake-only-placeholder',LIVE_APPROVED_PLAN:JSON.stringify(grant)};
  const values=await Promise.all([1,2].map(async()=>{const r=await worker.fetch(req('/api/live/conversations',{headers:identity}),env);assert.equal(r.status,200);return r.json();}));
  assert.ok(values.every(v=>!v.generation_enabled&&v.budget.status==='off'&&v.budget.can_enable&&v.budget.requests_reserved===6&&v.budget.remaining_requests===994&&v.budget.max_usd===10));assert.deepEqual((await store.get('budget',oldId)).value,old);assert.equal((await store.get('session',oldGrant.id)).value.enabled,true);assert.equal((await store.list('budget')).length,2);
  const control=values[0].budget.control_version;const on=await worker.fetch(req('/api/live/model-session',{method:'POST',headers:{...identity,Origin:'https://synthetic.example','Content-Type':'application/json'},body:JSON.stringify({enabled:true,expected_version:control})}),env);assert.equal(on.status,200);assert.equal((await on.json()).remaining_requests,994);
  for(const invalid of [{...grant,max_requests:1001},{...grant,max_usd:10.01},{...grant,max_usd:'10'}]){const r=await worker.fetch(req('/api/live/model-session',{headers:identity}),{...env,LIVE_APPROVED_PLAN:JSON.stringify(invalid)});assert.equal((await r.json()).status,'no_active_grant');}
  const expired={...env,LIVE_APPROVED_PLAN:JSON.stringify({...grant,expires_at:'2000-01-01T00:00:00Z'})};const ended=await(await worker.fetch(req('/api/live/model-session',{headers:identity}),expired)).json();assert.equal(ended.status,'expired');assert.equal(ended.can_enable,false);assert.equal((await store.get('budget',grant.id)).value.requests,6);
});

test('authorized60request extension preserves D1 consumption, switch and saved cases without a model call',async t=>{
  const d1=await migrated(t);if(!d1)return;
  const id='demo-session',store=new D1Store(d1,'global-live-budget'),owner=new D1Store(d1,'owner:owner-scoped-id');
  const original={id,max_requests:30,max_usd:1,expires_at:new Date(Date.now()+3600000).toISOString()};
  const previous={grant:original,requests:28,reserved_usd:0.07,retained_marker:'existing-consumption'};
  await store.put('budget',id,-1,previous);await store.put('session',id,-1,{strategy:'manual',enabled:true,budget_id:id,reason:'manual_on',grant_id:id});
  await store.put('budget','historical-allowance',-1,{requests:6,reserved_usd:0.015});
  await owner.put('case','saved-mia',-1,{id:'saved-mia',revision:0,busy:false,status:'approved',mode:'live_ai',live_grant_id:id,subject:'Synthetic retained Mia',deliveries:[]});
  const session=await store.get('session',id),saved=await owner.get('case','saved-mia'),historical=await store.get('budget','historical-allowance');
  const countEvents=()=>d1.db.prepare("SELECT COUNT(*) n FROM support_events WHERE namespace='global-live-budget' AND kind='budget' AND item_id=?").get(id).n;
  const before=countEvents(),grant={...original,max_requests:60,request_limit_extension:{authorization:'request-cap-extension-v1',from_max_requests:30}};
  const env={DB:d1,LIVE_OPERATOR_EMAIL:'owner@example.test',OPENAI_API_KEY:'fake-only-placeholder',LIVE_APPROVED_PLAN:JSON.stringify(grant)};
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Request-limit extension must not dispatch a provider');};
  try{
    for(let i=0;i<2;i++){
      const response=await worker.fetch(req('/api/live/conversations',{headers:identity}),env);assert.equal(response.status,200);const value=await response.json();
      assert.equal(value.budget.requests_reserved,28);assert.equal(value.budget.max_requests,60);assert.equal(value.budget.remaining_requests,32);
      assert.equal(value.budget.max_usd,1);assert.equal(value.budget.expires_at,original.expires_at);assert.equal(value.budget.model_on,true);assert.equal(value.conversations[0].id,'saved-mia');
    }
    const extended=await store.get('budget',id);assert.equal(extended.version,1);assert.equal(extended.value.requests,28);assert.equal(extended.value.reserved_usd,0.07);assert.equal(extended.value.retained_marker,previous.retained_marker);
    assert.deepEqual(extended.value.grant,grant);assert.equal(countEvents(),before+1);assert.equal(calls,0);
    assert.deepEqual(await store.get('session',id),session);assert.deepEqual(await owner.get('case','saved-mia'),saved);assert.deepEqual(await store.get('budget','historical-allowance'),historical);
    const oldResponse=await worker.fetch(req('/api/live/model-session',{headers:identity}),{...env,LIVE_APPROVED_PLAN:JSON.stringify(original)});
    assert.equal((await oldResponse.json()).status,'unavailable');assert.deepEqual(await store.get('budget',id),extended,'an old deployment cannot roll the extension back');
  }finally{globalThis.fetch=originalFetch;}
});
