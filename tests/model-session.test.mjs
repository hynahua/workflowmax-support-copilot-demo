import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationStore} from '../server/conversation-store.mjs';
import {boundedLiveProvider,grantShape,validGrant} from '../shared/live-budget.mjs';
import {conversationRehearsalProvider} from '../shared/conversation.mjs';
import {createConversationService} from '../server/conversation-config.mjs';
import {loadKnowledge} from '../server/knowledge.mjs';
import {AppError} from '../server/errors.mjs';
const corpus=await loadKnowledge();
const grantOf=(id='manual-test')=>({id,max_requests:6,max_usd:0.02,expires_at:new Date(Date.now()+3600000).toISOString()});
const request={instructions:'Synthetic test',input:{subject:'test'}};
async function storeFor(t){const dir=await mkdtemp(join(tmpdir(),'wmax-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new ConversationStore(dir).init();}
async function set(provider,enabled){return provider.setEnabled({enabled,expected_version:(await provider.availability()).control_version});}
const maya={subject:'Time entry',body:'How do I enter weekly timesheet time?',synthetic:true,event_id:'manual-case'};
test('manual session defaults OFF and survives restart and repeated switching without clearing use',async t=>{
  const store=await storeFor(t);let calls=0;const base={mode:'live_ai',model:'mock-only',generate:async()=>{calls++;return{};}};const grant=grantOf();let p=boundedLiveProvider(base,{store,grant});
  assert.equal((await p.availability()).status,'off');await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);
  await set(p,true);await p.generate(request);await set(p,false);await set(p,true);await set(p,false);
  p=boundedLiveProvider(base,{store:await new ConversationStore(store.directory).init(),grant});const info=await p.availability();assert.equal(info.status,'off');assert.equal(info.requests_reserved,1);assert.equal(info.remaining_requests,5);assert.equal(calls,1);
  const stale=info.control_version;await set(p,true);await assert.rejects(p.setEnabled({enabled:false,expected_version:stale}),{code:'STALE_MODEL_CONTROL'});
});
test('expiry, exhaustion, historical closure and provider failure cannot be bypassed by ON',async t=>{
  const store=await storeFor(t);
  for(const [name,value,expires,status]of[['expired',{},'2000-01-01','expired'],['exhausted',{requests:6,reserved_usd:0.015},null,'exhausted'],['old-success',{requests:3,reserved_usd:0.0075,halted:true,halt_code:'AUTHORIZED_CASE_FINISHED'},null,'closed'],['failed',{requests:1,reserved_usd:0.0025,halted:true,halt_code:'MODEL_NETWORK_FAILED'},null,'faulted']]){
    const grant=grantOf(name);if(expires)grant.expires_at=expires;await store.put('budget',name,-1,{grant,requests:0,reserved_usd:0,...value});const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{throw Error('must not dispatch');}},{store,grant});const info=await p.availability();assert.equal(info.status,status);await assert.rejects(set(p,true),{code:'MODEL_SESSION_BLOCKED'});
  }
});
test('authorized continuation is single-claim, inherits use/deadline and never changes the closed parent',async t=>{
  const store=await storeFor(t),grant=grantOf('specific-approved-parent');const parent={grant,requests:3,reserved_usd:0.0075,halted:true,halt_code:'AUTHORIZED_CASE_FINISHED',stopped_after_request:3};await store.put('budget',grant.id,-1,parent);
  let calls=0;const base={mode:'live_ai',model:'mock-only',generate:async()=>{calls++;return{};}};const options={store,grant,allowContinuation:true};const a=boundedLiveProvider(base,options),b=boundedLiveProvider(base,options);
  const [x,y]=await Promise.all([a.availability(),b.availability()]);assert.equal(x.requests_reserved,3);assert.equal(y.remaining_requests,3);assert.equal(x.expires_at,grant.expires_at);assert.equal(x.model_on,false);assert.equal((await store.list('budget')).length,2);assert.deepEqual((await store.get('budget',grant.id)).value,parent);
  await set(a,true);await a.generate(request);await a.generate(request);await a.generate(request);assert.equal(calls,3);assert.equal((await a.availability()).status,'exhausted');await assert.rejects(set(a,true),{code:'MODEL_SESSION_BLOCKED'});assert.deepEqual((await store.get('budget',grant.id)).value,parent);
});
test('failed and expired parent grants are never continued even when migration is allowed',async t=>{
  const store=await storeFor(t);for(const [id,code,expires]of[['old-failure','MODEL_NETWORK_FAILED',null],['expired-parent','AUTHORIZED_CASE_FINISHED','2000-01-01']]){const grant=grantOf(id);if(expires)grant.expires_at=expires;await store.put('budget',id,-1,{grant,requests:3,reserved_usd:0.0075,halted:true,halt_code:code});const p=boundedLiveProvider({mode:'live_ai'}, {store,grant,allowContinuation:true});assert.equal((await p.availability()).continued_from_success,false);assert.equal((await store.get('session',id)).value.budget_id,id);}
});
test('atomic switch guard prevents dispatch if OFF wins before reservation',async t=>{
  const store=await storeFor(t),grant=grantOf();let calls=0;const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant});await set(p,true);
  const reserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{await set(p,false);return reserve(...args);};await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);assert.equal((await p.availability()).requests_reserved,0);
});
test('OFF after reservation blocks dispatch and retains its counted request',async t=>{
  const store=await storeFor(t),grant=grantOf();let calls=0;const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant});await set(p,true);
  const reserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{await reserve(...args);await set(p,false);};await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);assert.equal((await p.availability()).requests_reserved,1);
});
test('an in-flight request may finish after OFF; the next request is blocked without a reset',async t=>{
  const store=await storeFor(t);let release,started;const began=new Promise(r=>started=r);const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{started();return new Promise(r=>release=r);}},{store,grant:grantOf()});await set(p,true);const pending=p.generate(request);await began;await set(p,false);release({done:true});assert.deepEqual(await pending,{done:true});await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal((await p.availability()).requests_reserved,1);
});
test('two cases can reach review while manual session stays ON; review/test send still work OFF',async t=>{
  const store=await storeFor(t),grant=grantOf();const provider=boundedLiveProvider({...conversationRehearsalProvider(),mode:'live_ai',model:'mock-only'},{store,grant});await set(provider,true);const service=await createConversationService({store,provider,corpus});
  const a=await service.create(maya),b=await service.create({...maya,event_id:'second-case'});assert.equal(a.status,'awaiting_review');assert.equal(b.status,'awaiting_review');assert.equal((await provider.availability()).requests_reserved,4);assert.equal((await provider.availability()).enabled,true);
  await set(provider,false);let r=await service.review(a.id,{expected_revision:a.revision,action:'approve',reviewer:'Synthetic manual-session QA',note:'Source checked in mock test.',draft:a.draft,confirmed:true});r=await service.send(a.id,{expected_revision:r.revision,approved_hash:r.approval.hash});assert.equal(r.status,'sent_test');assert.equal((await provider.availability()).requests_reserved,4);
});
test('OFF between stages preserves triage/evidence; explicit resume dispatches only pending draft',async t=>{
  const store=await storeFor(t),grant=grantOf();const base=conversationRehearsalProvider();const phases=[];let provider;
  provider=boundedLiveProvider({mode:'live_ai',model:'mock-only',async generate(r){phases.push(r.phase);const output=await base.generate(r);if(r.phase==='triage')await set(provider,false);return output;}},{store,grant});await set(provider,true);const service=await createConversationService({store,provider,corpus});let record=await service.create(maya);
  assert.equal(record.status,'model_paused');assert.equal(record.resume_stage,'draft');assert.equal(record.attempts[0].output.decision,'retrieve');assert.ok(record.sources.length);assert.equal((await provider.availability()).requests_reserved,1);assert.equal(record.attempts.at(-1).provider_requested,false);
  await set(provider,true);record=await service.resume(record.id,{expected_revision:record.revision});assert.equal(record.status,'awaiting_review');assert.deepEqual(phases,['triage','draft']);assert.equal((await provider.availability()).requests_reserved,2);
});
test('a provider fault stops the session and toggle cannot re-enable it',async t=>{
  const store=await storeFor(t);const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{throw new AppError('MODEL_NETWORK_FAILED','Synthetic network failure',503);}},{store,grant:grantOf()});await set(p,true);await assert.rejects(p.generate(request),{code:'MODEL_NETWORK_FAILED'});assert.equal((await p.availability()).status,'faulted');await assert.rejects(set(p,true),{code:'MODEL_SESSION_BLOCKED'});
});

test('paused draft repairs preserve the first-plus-three limit across explicit resume',async t=>{
  const store=await storeFor(t),grant=grantOf();const base=conversationRehearsalProvider();let drafts=0,provider;const phases=[];
  provider=boundedLiveProvider({mode:'live_ai',model:'mock-only',async generate(r){phases.push(r.phase);const out=await base.generate(r);if(r.phase==='draft'){drafts++;if(drafts===2)await set(provider,false);return{...out,citation_ids:['K-999']};}return out;}},{store,grant});await set(provider,true);const service=await createConversationService({store,provider,corpus});let r=await service.create(maya);assert.equal(r.status,'model_paused');assert.equal(drafts,2);await set(provider,true);r=await service.resume(r.id,{expected_revision:r.revision});assert.equal(r.status,'human_required');assert.equal(drafts,4);assert.equal(phases.filter(p=>p==='triage').length,1);assert.equal((await provider.availability()).status,'faulted');
});

test('competing requests reserve separate counted slots without retrying a provider',async t=>{
  const store=await storeFor(t);let calls=0;const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant:grantOf()});await set(p,true);await Promise.all([p.generate(request),p.generate(request)]);assert.equal(calls,2);assert.equal((await p.availability()).requests_reserved,2);assert.equal((await p.availability()).status,'ready');
});
test('OFF then ON before dispatch does not silently resume an accepted-but-unsent request',async t=>{
  const store=await storeFor(t);let calls=0;const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant:grantOf()});await set(p,true);const reserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{await reserve(...args);await set(p,false);await set(p,true);};await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);assert.equal((await p.availability()).requests_reserved,1);
});
test('a concurrent terminal stop after reservation blocks dispatch and preserves the counted slot',async t=>{
  const store=await storeFor(t);let calls=0;const grant=grantOf(),p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant});await set(p,true);
  const reserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{await reserve(...args);const row=await store.get('budget',grant.id);await store.put('budget',grant.id,row.version,{...row.value,halted:true,halt_code:'MODEL_NETWORK_FAILED'});};
  await assert.rejects(p.generate(request),{code:'LIVE_BATCH_STOPPED'});assert.equal(calls,0);assert.equal((await p.availability()).requests_reserved,1);await assert.rejects(set(p,true),{code:'MODEL_SESSION_BLOCKED'});
});
test('reservation contention cannot adopt a later OFF-to-ON switch version',async t=>{
  const store=await storeFor(t);let calls=0,reservations=0;const p=boundedLiveProvider({mode:'live_ai',generate:async()=>{calls++;return{};}},{store,grant:grantOf()});await set(p,true);
  const reserve=store.reserveModelRequest.bind(store);store.reserveModelRequest=async(...args)=>{if(reservations++===0){await set(p,false);await set(p,true);throw new AppError('STALE_CASE','Synthetic competing reservation',409);}return reserve(...args);};
  await assert.rejects(p.generate(request),{code:'MODEL_SESSION_OFF'});assert.equal(calls,0);assert.equal((await p.availability()).requests_reserved,0);
});


test('practice grant validates strict finite limits while accepting historical grants',()=>{
  const base=grantOf();assert.equal(grantShape(base),true);assert.equal(grantShape({...base,max_requests:1000,max_usd:10}),true);
  for(const max_requests of [0,-1,1.5,1001,NaN,Infinity,'1000',null])assert.equal(grantShape({...base,max_requests}),false);
  for(const max_usd of [0,-1,10.01,NaN,Infinity,'10',null])assert.equal(grantShape({...base,max_usd}),false);
  for(const expires_at of [null,0,'not-a-date',Infinity])assert.equal(grantShape({...base,expires_at}),false);
  const boundary={...base,expires_at:new Date(Date.now()-1).toISOString()};assert.equal(grantShape(boundary),true);assert.equal(validGrant(boundary),false);
});
test('new practice session carries the exhausted count once and preserves old switch and counters',async t=>{
  const store=await storeFor(t),old=grantOf('old-practice');const parent={grant:old,requests:6,reserved_usd:0.015};await store.put('budget',old.id,-1,parent);await store.put('session',old.id,-1,{enabled:true,budget_id:old.id});
  const grant={...grantOf('evening'),max_requests:1000,max_usd:10};let calls=0;const base={mode:'live_ai',generate:async()=>{calls++;return{};}};const options={store,grant,carryForwardBudgetId:old.id};const a=boundedLiveProvider(base,options),b=boundedLiveProvider(base,options);
  const states=await Promise.all([a.availability(),b.availability()]);assert.ok(states.every(x=>x.status==='off'&&x.can_enable&&x.requests_reserved===6&&x.remaining_requests===994&&x.max_usd===10));assert.equal((await store.list('budget')).length,2);assert.deepEqual((await store.get('budget',old.id)).value,parent);assert.equal((await store.get('session',old.id)).value.enabled,true);
  await set(a,true);await a.generate(request);await set(a,false);assert.equal((await b.availability()).requests_reserved,7);assert.equal(calls,1);assert.deepEqual((await store.get('budget',old.id)).value,parent);
});
test('practice count carry refuses failed, incomplete or changed parent state',async t=>{
  const store=await storeFor(t);for(const [id,extra]of [['failed',{requests:6,halted:true,halt_code:'MODEL_NETWORK_FAILED'}],['incomplete',{requests:5}],['invalid-cost',{requests:6,reserved_usd:NaN}]]){
    const old=grantOf(id);await store.put('budget',id,-1,{grant:old,reserved_usd:0.015,...extra});const p=boundedLiveProvider({mode:'live_ai'},{store,grant:{...grantOf('next-'+id),max_requests:1000,max_usd:10},carryForwardBudgetId:id});await assert.rejects(p.availability(),{code:'PRACTICE_CARRY_INVALID'});assert.equal(await store.get('session','next-'+id),null);
  }
});
test('practice request, cost and expiry guards still stop at their exact boundaries',async t=>{
  const store=await storeFor(t);let calls=0;const base={mode:'live_ai',generate:async()=>{calls++;return{};}};
  const grant={...grantOf('thousand'),max_requests:1000,max_usd:10};await store.put('budget',grant.id,-1,{grant,requests:999,reserved_usd:2.4975});const p=boundedLiveProvider(base,{store,grant});await set(p,true);await p.generate(request);assert.equal((await p.availability()).requests_reserved,1000);await assert.rejects(p.generate(request),{code:'LIVE_BUDGET_EXHAUSTED'});await assert.rejects(set(p,true),{code:'MODEL_SESSION_BLOCKED'});
  const cost={...grantOf('cost'),max_requests:1000,max_usd:0.005};const c=boundedLiveProvider(base,{store,grant:cost});await set(c,true);await c.generate(request);await c.generate(request);await assert.rejects(c.generate(request),{code:'LIVE_BUDGET_EXHAUSTED'});
  const expired={...grantOf('ended'),max_requests:1000,max_usd:10,expires_at:'2000-01-01T00:00:00Z'};const e=boundedLiveProvider(base,{store,grant:expired});assert.equal((await e.availability()).status,'expired');await assert.rejects(set(e,true),{code:'MODEL_SESSION_BLOCKED'});await assert.rejects(e.generate(request),{code:'LIVE_BUDGET_REQUIRED'});assert.equal(calls,3);
});

const interviewGrant=()=>({...grantOf('demo-session'),max_requests:30,max_usd:1});
const extendedGrant=grant=>({...grant,max_requests:60,request_limit_extension:{authorization:'request-cap-extension-v1',from_max_requests:30}});
async function interviewAllowance(t,{requests=28,reserved_usd=0.07,enabled=true,extra={}}={}){
  const store=await storeFor(t),grant=interviewGrant();
  const value={grant,requests,reserved_usd,synthetic_marker:'keep all budget fields',...extra};
  await store.put('budget',grant.id,-1,value);
  await store.put('session',grant.id,-1,{enabled,budget_id:grant.id,reason:'existing-model-switch',marker:'keep policy'});
  return{store,grant,value,session:await store.get('session',grant.id)};
}
test('request-cap-extension-v1 extends the same request allowance once while preserving use, cost, switch and other saved fields',async t=>{
  const f=await interviewAllowance(t);let calls=0;const base={mode:'live_ai',model:'mock-only',async generate(){calls++;throw Error('Extension must not dispatch');}};
  await f.store.put('budget','unrelated-grant',-1,{requests:9});const other=await f.store.get('budget','unrelated-grant');
  let p=boundedLiveProvider(base,{store:f.store,grant:extendedGrant(f.grant)});const info=await p.availability();
  assert.equal(info.status,'ready');assert.equal(info.max_requests,60);assert.equal(info.requests_reserved,28);assert.equal(info.remaining_requests,32);assert.equal(info.conservative_reserved_usd,0.07);assert.equal(info.max_usd,1);assert.equal(info.expires_at,f.grant.expires_at);assert.equal(info.control_version,f.session.version);
  const migrated=await f.store.get('budget',f.grant.id);assert.equal(migrated.version,1);assert.equal(migrated.value.synthetic_marker,f.value.synthetic_marker);assert.deepEqual(migrated.value.grant,extendedGrant(f.grant));
  assert.equal(migrated.value.request_limit_extensions.length,1);const audit=migrated.value.request_limit_extensions[0];assert.equal(audit.authorization,'request-cap-extension-v1');assert.equal(audit.from_max_requests,30);assert.equal(audit.to_max_requests,60);assert.equal(audit.previous_budget_version,0);assert.equal(audit.requests,28);assert.equal(audit.reserved_usd,0.07);assert.ok(Number.isFinite(Date.parse(audit.at)));
  assert.deepEqual(await f.store.get('session',f.grant.id),f.session);assert.deepEqual(await f.store.get('budget','unrelated-grant'),other);
  p=boundedLiveProvider(base,{store:await new ConversationStore(f.store.directory).init(),grant:extendedGrant(f.grant)});await p.availability();await p.availability();
  assert.deepEqual(await f.store.get('budget',f.grant.id),migrated);assert.equal(calls,0);
});
test('request-cap-extension-v1 preserves OFF and can extend request exhaustion without bypassing the original cost guard',async t=>{
  for(const [enabled,reserved_usd,status]of[[false,0.075,'off'],[true,0.075,'ready'],[true,1,'exhausted']]){
    const f=await interviewAllowance(t,{requests:30,reserved_usd,enabled});let calls=0;const p=boundedLiveProvider({mode:'live_ai',async generate(){calls++;return{};}},{store:f.store,grant:extendedGrant(f.grant)});
    const info=await p.availability();assert.equal(info.status,status);assert.equal(info.requests_reserved,30);assert.equal(info.unused_requests,30);assert.equal(info.conservative_reserved_usd,reserved_usd);assert.deepEqual(await f.store.get('session',f.grant.id),f.session);
    if(status==='exhausted'){await assert.rejects(p.generate(request),{code:'LIVE_BUDGET_EXHAUSTED'});await assert.rejects(set(p,true),{code:'MODEL_SESSION_BLOCKED'});}
    assert.equal(calls,0);
  }
});
test('unapproved, decreased or malformed request-limit changes never initialize or overwrite saved allowance',async t=>{
  const f=await interviewAllowance(t);const before=await f.store.get('budget',f.grant.id);
  const changed={...f.grant,max_requests:60};const ordinary=boundedLiveProvider({mode:'live_ai'},{store:f.store,grant:changed});assert.equal((await ordinary.availability()).status,'unavailable');
  const variants=[null,{},[],{authorization:'unapproved-extension',from_max_requests:30},{authorization:'request-cap-extension-v1',from_max_requests:'30'},{authorization:'request-cap-extension-v1',from_max_requests:29},{authorization:'request-cap-extension-v1',from_max_requests:30,extra:true}];
  const grants=[...variants.map(request_limit_extension=>({...changed,request_limit_extension})),{...extendedGrant(f.grant),max_requests:29},{...extendedGrant(f.grant),max_requests:61},{...extendedGrant(f.grant),id:'different-grant'}];
  for(const grant of grants){assert.equal(grantShape(grant),false);const p=boundedLiveProvider({mode:'live_ai'},{store:f.store,grant});assert.equal((await p.availability()).status,'no_active_grant');}
  assert.deepEqual(await f.store.get('budget',f.grant.id),before);assert.deepEqual(await f.store.get('session',f.grant.id),f.session);assert.equal(await f.store.get('session','different-grant'),null);
});
test('request-cap-extension-v1 refuses changed money, expiry, identity, halted state and unverifiable prior counts',async t=>{
  for(const variant of ['money','expiry','prior-id','halted','faulted','requests','cost','audit','expired']){
    const f=await interviewAllowance(t);const grant=extendedGrant(f.grant);let value=f.value;
    if(variant==='money')grant.max_usd=2;
    if(variant==='expiry')grant.expires_at=new Date(Date.parse(grant.expires_at)+60000).toISOString();
    if(variant==='prior-id')value={...value,grant:{...f.grant,id:'mismatched-prior-grant'}};
    if(variant==='halted')value={...value,halted:true,halt_code:'AUTHORIZED_CASE_FINISHED'};
    if(variant==='faulted')value={...value,halt_code:'MODEL_NETWORK_FAILED'};
    if(variant==='requests')value={...value,requests:31};
    if(variant==='cost')value={...value,reserved_usd:-1};
    if(variant==='audit')value={...value,request_limit_extensions:{authorization:'request-cap-extension-v1'}};
    if(variant==='expired'){grant.expires_at='2000-01-01T00:00:00.000Z';value={...value,grant:{...f.grant,expires_at:grant.expires_at}};}
    if(value!==f.value)await f.store.put('budget',f.grant.id,0,value);
    const before=await f.store.get('budget',f.grant.id),p=boundedLiveProvider({mode:'live_ai'},{store:f.store,grant});
    await assert.rejects(p.availability(),{code:'REQUEST_LIMIT_EXTENSION_INVALID'});assert.deepEqual(await f.store.get('budget',f.grant.id),before);assert.deepEqual(await f.store.get('session',f.grant.id),f.session);
  }
});
test('request-cap-extension-v1 requires the existing same-id session and budget instead of creating or resetting either',async t=>{
  for(const variant of ['empty','missing-budget','missing-session','other-budget']){
    const store=await storeFor(t),grant=interviewGrant();
    if(variant==='missing-session')await store.put('budget',grant.id,-1,{grant,requests:28,reserved_usd:0.07});
    if(variant==='missing-budget'||variant==='other-budget')await store.put('session',grant.id,-1,{enabled:true,budget_id:variant==='other-budget'?'some-other-budget':grant.id});
    const before=JSON.stringify([await store.list('budget'),await store.list('session')]);const p=boundedLiveProvider({mode:'live_ai'},{store,grant:extendedGrant(grant)});
    await assert.rejects(p.availability(),{code:'REQUEST_LIMIT_EXTENSION_INVALID'});assert.equal(JSON.stringify([await store.list('budget'),await store.list('session')]),before);
  }
});
test('request-cap-extension-v1 fails closed on a competing reservation and a fresh read preserves the winner before extending',async t=>{
  const f=await interviewAllowance(t),put=f.store.put.bind(f.store);let competed=false;
  f.store.put=async(kind,id,version,value)=>{if(kind==='budget'&&value.grant?.request_limit_extension&&!competed){competed=true;const row=await f.store.get(kind,id);await put(kind,id,row.version,{...row.value,requests:29,reserved_usd:0.0725});}return put(kind,id,version,value);};
  const p=boundedLiveProvider({mode:'live_ai'},{store:f.store,grant:extendedGrant(f.grant)});await assert.rejects(p.availability(),{code:'STALE_CASE'});
  const winner=await f.store.get('budget',f.grant.id);assert.equal(winner.value.requests,29);assert.equal(winner.value.grant.max_requests,30);assert.equal(winner.value.request_limit_extensions,undefined);
  const info=await p.availability();assert.equal(info.requests_reserved,29);assert.equal(info.remaining_requests,31);assert.equal(info.conservative_reserved_usd,0.0725);assert.equal((await f.store.get('budget',f.grant.id)).value.request_limit_extensions.length,1);assert.deepEqual(await f.store.get('session',f.grant.id),f.session);
});
test('a same-grant paused draft resumes after request-cap-extension-v1 without replaying completed model steps',async t=>{
  const store=await storeFor(t),grant=interviewGrant(),base=conversationRehearsalProvider(),phases=[];let provider;
  const model={mode:'live_ai',model:'mock-only',async generate(value){phases.push(value.phase);const output=await base.generate(value);if(value.phase==='triage')await set(provider,false);return output;}};
  provider=boundedLiveProvider(model,{store,grant});await set(provider,true);let service=await createConversationService({store,provider,corpus}),record=await service.create(maya);
  assert.equal(record.status,'model_paused');assert.equal(record.resume_stage,'draft');assert.deepEqual(phases,['triage']);const session=await store.get('session',grant.id);
  provider=boundedLiveProvider(model,{store,grant:extendedGrant(grant)});assert.equal((await provider.availability()).status,'off');assert.deepEqual(await store.get('session',grant.id),session);assert.deepEqual(phases,['triage']);
  await set(provider,true);service=await createConversationService({store,provider,corpus});record=await service.resume(record.id,{expected_revision:record.revision});
  assert.equal(record.status,'awaiting_review');assert.deepEqual(phases,['triage','draft']);assert.equal((await provider.availability()).requests_reserved,2);assert.equal((await provider.availability()).max_requests,60);
});
