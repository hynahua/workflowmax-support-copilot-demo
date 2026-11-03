import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
const source=await readFile(new URL('../public/conversation.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/conversation.html',import.meta.url),'utf8');
const saved={created_at:new Date().toISOString(),id:'saved-synthetic',subject:'Saved synthetic Maya case',status:'sent_test',mode:'live_ai',model:'gpt-6-luna',revision:9,messages:[{role:'customer',text:'Synthetic original'},{role:'assistant',text:'Synthetic approved answer'}],sources:[],deliveries:[{kind:'answer',status:'sent_test',body:'Synthetic approved answer',hash:'synthetic-hash',receipt:'test-synthetic'}],attempts:[],overrides:[],approval:null,review_history:[]};
function element(tag='div'){
  return{tag,hidden:false,disabled:false,value:'',textContent:'',children:[],listeners:{},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},append(...items){this.children.push(...items);this.textContent+=items.map(i=>i.textContent||'').join('');},replaceChildren(...items){this.children=items;this.textContent=items.map(i=>i.textContent||'').join('');},click(){if(!this.disabled)return this.listeners.click?.();}};
}
async function page(response,{status=200,networkFailure=false,fetchResponse}={}){
  const nodes=new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([,tag,id])=>[id,element(tag)]));
  const requests=[];const document={getElementById:id=>nodes.get(id),createElement:element,querySelectorAll:()=>[...nodes.values()].filter(n=>n.tag==='button')};
  runInNewContext(source,{document,window:{},location:{pathname:'/live'},crypto:{randomUUID},fetch:async(path,options)=>{requests.push({path,method:options?.method||'GET',...(options?.body?{value:JSON.parse(options.body)}:{})});if(networkFailure)throw Error('Temporary connection failure');const value=fetchResponse?await fetchResponse(path,options):response;return{ok:status===200,json:async()=>value};}});
  await new Promise(setImmediate);
  return{nodes,requests};
}
const owner=(budget='closed',enabled=false)=>({cloud:true,access:{status:'signed_in',role:'owner'},mode:enabled?'live_ai':'not_connected',model:'gpt-6-luna',generation_enabled:enabled,budget:{status:budget,remaining_requests:enabled?2:0},conversations:[saved]});
for(const state of ['closed','no_active_grant'])test(`signed-in owner with ${state} sees completed test status and can open saved records`,async()=>{
  const {nodes,requests}=await page(owner(state));
  assert.equal(nodes.get('signInV2').hidden,true);assert.equal(nodes.get('accessStatus').textContent,'Signed in as the workspace owner.');
  assert.match(nodes.get('mode').textContent,/test has ended.*view saved records.*limited authorization/);assert.doesNotMatch(nodes.get('mode').textContent,/secret|key|identity|not_connected|closed/);
  assert.equal(nodes.get('start').disabled,true);assert.equal(nodes.get('reply').disabled,true);
  nodes.get('cases').children[0].click();assert.equal(nodes.get('status').textContent,'Completed · test outbox');assert.equal(nodes.get('conversationPanel').hidden,false);assert.match(nodes.get('resultV2').textContent,/No real email was sent/);assert.deepEqual(requests,[{path:'/api/live/conversations',method:'GET'}]);
});
test('signed-in owner with active budget sees separate sign-in confirmation and request allowance',async()=>{
  const {nodes,requests}=await page(owner('ready',true));assert.equal(nodes.get('signInV2').hidden,true);assert.match(nodes.get('accessStatus').textContent,/Signed in/);assert.equal(nodes.get('start').disabled,false);assert.match(nodes.get('mode').textContent,/Remaining approved requests: 2/);assert.equal(requests.length,1);
});
for(const [state,status]of[['signed_out',401],['not_authorized',403]])test(`${state} shows its appropriate account entry without suggesting a key problem`,async()=>{
  const {nodes}=await page({access:{status:state},error:{code:state==='signed_out'?'LIVE_SIGN_IN_REQUIRED':'LIVE_FORBIDDEN',message:'Synthetic access denial'}},{status});
  assert.equal(nodes.get('signInV2').hidden,false);assert.equal(nodes.get('start').disabled,true);
  assert.match(nodes.get('accessStatus').textContent,state==='signed_out'?/not signed in/:/signed in, but/);
  assert.match(nodes.get('signInV2').textContent,state==='signed_out'?/Sign in with ChatGPT/:/Choose the owner account/);assert.doesNotMatch(nodes.get('mode').textContent,/secret|key|test has ended/);
});
test('a network failure does not incorrectly ask an unknown session to sign in again',async()=>{
  const {nodes}=await page(null,{networkFailure:true});assert.equal(nodes.get('signInV2').hidden,true);assert.match(nodes.get('accessStatus').textContent,/could not be checked/);assert.match(nodes.get('mode').textContent,/could not be loaded/);assert.doesNotMatch(nodes.get('startHint').textContent,/Sign in|test has ended/);assert.equal(nodes.get('start').disabled,true);
});

test('completed and handoff cards explain their outcome and live mode without internal status codes',async()=>{
  const data=owner();data.conversations.push({...saved,id:'failed-synthetic',status:'human_required'});
  const {nodes,requests}=await page(data);const cards=nodes.get('cases').children;
  assert.match(cards[0].textContent,/Completed · test outbox.*Live AI mode/);assert.match(cards[1].textContent,/Needs human review.*Live AI mode/);assert.doesNotMatch(cards.map(c=>c.textContent).join(' '),/sent_test|human_required|live_ai/);
  assert.match(nodes.get('startHint').textContent,/test has ended.*Completed.*limited authorization/);assert.match(nodes.get('nextStep').textContent,/open Completed.*without making model calls/);assert.match(nodes.get('sourcesV2').textContent,/No evidence yet.*clarification/);
  cards[0].click();assert.match(nodes.get('nextStep').textContent,/Completed: follow the messages/);assert.equal(JSON.parse(nodes.get('auditV2').textContent).status,'sent_test');
  nodes.get('new').click();assert.match(nodes.get('sourcesV2').textContent,/No evidence yet/);assert.equal(requests.length,1);
});
test('the next action distinguishes customer reply, support review and approved test delivery',async()=>{
  const {nodes,requests}=await page({...owner('ready',true),conversations:[{...saved,status:'awaiting_reply'},{...saved,status:'awaiting_review'},{...saved,status:'approved'}]});
  const cards=nodes.get('cases').children;
  cards[0].click();assert.match(nodes.get('nextStep').textContent,/act as the customer.*clarification.*reply/);
  cards[1].click();assert.match(nodes.get('nextStep').textContent,/act as support.*evidence.*approve this exact version/);
  cards[2].click();assert.match(nodes.get('nextStep').textContent,/saved approved version.*TEST outbox.*No real email/);assert.equal(requests.length,1);
});

test('manual switch displays used/remaining separately and ON/OFF posts never generate a case',async()=>{
  let data={...owner('off'),budget:{manual_control:true,model_on:false,can_enable:true,control_version:0,status:'off',stop_reason:'Model is OFF.',requests_reserved:3,max_requests:6,remaining_requests:3,max_usd:0.02,expires_at:'2026-11-01T07:46:41.000Z'}};
  const {nodes,requests}=await page(data,{fetchResponse:async(path,options)=>{if(options?.method==='POST'){assert.equal(path,'/api/live/model-session');const v=JSON.parse(options.body);data={...data,generation_enabled:v.enabled,budget:{...data.budget,model_on:v.enabled,status:v.enabled?'ready':'off',control_version:data.budget.control_version+1}};return data.budget;}return data;}});
  assert.equal(nodes.get('modelControls').hidden,false);assert.match(nodes.get('modelSessionState').textContent,/Model OFF.*Used 3 of 6.*3 requests left.*18:46:41 Melbourne/);assert.equal(nodes.get('start').disabled,true);
  nodes.get('cases').children[0].click();nodes.get('draftV2').value='Unsaved synthetic review edit';nodes.get('confirmV2').checked=true;
  await nodes.get('modelToggle').click();assert.match(nodes.get('modelToggle').textContent,/Model ON/);assert.equal(nodes.get('draftV2').value,'Unsaved synthetic review edit');assert.equal(nodes.get('confirmV2').checked,true);nodes.get('new').click();assert.equal(nodes.get('start').disabled,false);
  await nodes.get('modelToggle').click();assert.match(nodes.get('modelToggle').textContent,/Model OFF/);assert.equal(nodes.get('start').disabled,true);assert.match(nodes.get('modelSessionState').textContent,/Used 3 of 6.*3 requests left/);
  assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.path==='/api/live/model-session'));assert.equal(requests.filter(r=>r.method==='POST').length,2);
});
test('faulted manual session cannot be turned ON in the interface; saved review remains accessible',async()=>{
  const {nodes}=await page({...owner('faulted'),budget:{manual_control:true,model_on:false,can_enable:false,control_version:2,status:'faulted',stop_reason:'Session stopped after a provider failure.',requests_reserved:1,max_requests:6,remaining_requests:0,max_usd:0.02,expires_at:'2026-11-01T07:46:41.000Z'}});
  assert.equal(nodes.get('modelToggle').disabled,true);assert.match(nodes.get('modelSessionReason').textContent,/provider failure/);nodes.get('cases').children[0].click();assert.equal(nodes.get('conversationPanel').hidden,false);
});


test('evening practice UI shows inherited use, 1000 request cap, USD10 and Melbourne 22:00',async()=>{
  const {nodes,requests}=await page({...owner('off'),budget:{manual_control:true,model_on:false,can_enable:true,control_version:0,status:'off',stop_reason:'Model is OFF.',requests_reserved:6,max_requests:1000,remaining_requests:994,max_usd:10,expires_at:'2026-11-01T11:00:00.000Z'}});
  assert.match(nodes.get('modelSessionState').textContent,/Model OFF.*Used 6 of 1000 requests.*994 requests left.*22:00:00 Melbourne.*Budget US\$10.00/);assert.equal(nodes.get('modelToggle').disabled,false);assert.equal(nodes.get('start').disabled,true);assert.equal(requests.length,1);
});

test('only retrieved HTTPS source URLs become links in delivered replies, without changing saved text',async()=>{
  const url='https://support.workflowmax.com/hc/en-us/articles/24773474827161-About-timesheets';
  const body=`Manual saving [K-002]\n\nFurther guidance:\nAbout timesheets: ${url}\nhttps://untrusted.example/ <img src=x onerror=alert(1)>`;
  const record={...saved,sources:[{id:'K-002',title:'About timesheets',url,facts:[],conditions:[]}],messages:[{role:'customer',text:url},{role:'assistant',text:body}],deliveries:[{kind:'answer',status:'sent_test',body,hash:'saved-hash',receipt:'test-link'}]};
  const {nodes,requests}=await page({...owner(),conversations:[record]});nodes.get('cases').children[0].click();
  const links=node=>[...(node.tag==='a'?[node]:[]),...node.children.flatMap(links)];
  assert.equal(links(nodes.get('messages').children[0]).length,0);
  for(const node of [nodes.get('messages').children[1],nodes.get('outbox').children[0]]){
    const anchors=links(node);assert.equal(anchors.length,1);assert.equal(anchors[0].href,url);assert.equal(anchors[0].rel,'noopener noreferrer');
    assert.ok(node.textContent.includes('https://untrusted.example/ <img'));
  }
  assert.equal(nodes.get('messages').children[1].textContent,`Support / test transport: ${body}`);
  assert.equal(requests.length,1);
});

for(const state of ['awaiting_review','human_required'])test(`${state}: approval requires a checked confirmation and a non-empty current draft`,async()=>{
  const record={...saved,status:state,draft:'Synthetic reply with reviewed evidence. [K-002]'};
  const {nodes,requests}=await page({...owner('ready',true),conversations:[record]});
  nodes.get('cases').children[0].click();
  const button=nodes.get('approveV2'), confirmation=nodes.get('confirmV2'), draft=nodes.get('draftV2');
  assert.equal(button.disabled,true);await button.click();assert.equal(requests.length,1);
  confirmation.checked=true;confirmation.listeners.change();assert.equal(button.disabled,false);
  confirmation.checked=false;confirmation.listeners.change();assert.equal(button.disabled,true);
  confirmation.checked=true;confirmation.listeners.change();draft.value+=' Edited.';draft.listeners.input();
  assert.equal(confirmation.checked,false);assert.equal(button.disabled,true);
  confirmation.checked=true;confirmation.listeners.change();assert.equal(button.disabled,false);
  nodes.get('cases').children[0].click();assert.equal(confirmation.checked,false);assert.equal(button.disabled,true);
  draft.value='   ';draft.listeners.input();confirmation.checked=true;confirmation.listeners.change();assert.equal(button.disabled,true);
  assert.equal(requests.length,1,'checkbox and edits make no API calls');
});

test('New example cycles different customers and scenarios without creating records or calling the provider',async()=>{
  const {nodes,requests}=await page(owner('off'));
  const subjects=[nodes.get('subjectV2').value], bodies=[nodes.get('bodyV2').value];
  assert.equal(nodes.get('preparedList').children.length,1);assert.match(nodes.get('exampleLabel').textContent,/Maya.*1 of 4/);
  for(const name of ['Mia','Liam','Ava']){nodes.get('new').click();subjects.push(nodes.get('subjectV2').value);bodies.push(nodes.get('bodyV2').value);assert.match(nodes.get('exampleLabel').textContent,new RegExp(name));}
  assert.equal(new Set(subjects).size,4);assert.equal(new Set(bodies).size,4);assert.equal(nodes.get('preparedList').children.length,4);
  assert.equal(nodes.get('start').disabled,true,'sample preparation still works with model OFF');
  nodes.get('new').click();assert.match(nodes.get('exampleLabel').textContent,/Maya.*1 of 4/);assert.equal(requests.length,1);
});

test('prepared mail keeps edits when switching and review confirmation/notes do not leak across records',async()=>{
  const {nodes,requests}=await page(owner('ready',true));
  nodes.get('subjectV2').value='Edited synthetic subject';nodes.get('subjectV2').listeners.input();
  nodes.get('bodyV2').value='Edited synthetic email';nodes.get('bodyV2').listeners.input();
  nodes.get('new').click();assert.match(nodes.get('bodyV2').value,/Mia/);
  nodes.get('preparedList').children[0].click();assert.equal(nodes.get('subjectV2').value,'Edited synthetic subject');assert.equal(nodes.get('bodyV2').value,'Edited synthetic email');
  nodes.get('noteV2').value='Old review note';nodes.get('confirmV2').checked=true;
  nodes.get('cases').children[0].click();assert.equal(nodes.get('noteV2').value,'');assert.equal(nodes.get('confirmV2').checked,false);
  assert.equal(nodes.get('preparedList').children.length,2);assert.equal(requests.length,1);
});

test('all saved ongoing and completed cases live behind a separate, filterable history view',async()=>{
  const states=['awaiting_reply','awaiting_review','approved','human_required','model_paused','delivery_unknown','delivery_failed','sent_test','rejected'];
  const data={...owner(),conversations:states.map((status,i)=>({...saved,id:`history-${i}`,status,created_at:new Date().toISOString()}))};
  const {nodes,requests}=await page(data);
  assert.equal(nodes.get('historyView').hidden,true);assert.equal(nodes.get('preparedList').children.length,1);assert.match(nodes.get('viewHistory').textContent,/9/);
  nodes.get('viewHistory').click();assert.equal(nodes.get('workspaceView').hidden,true);assert.equal(nodes.get('historyView').hidden,false);assert.equal(nodes.get('cases').children.length,9);
  nodes.get('history-ongoing').click();assert.equal(nodes.get('cases').children.length,7);
  nodes.get('history-finished').click();assert.equal(nodes.get('cases').children.length,2);
  nodes.get('history-rejected').click();assert.equal(nodes.get('cases').children.length,1);assert.match(nodes.get('cases').textContent,/Rejected · not sent/);assert.doesNotMatch(nodes.get('cases').textContent,/Needs human review/);
  nodes.get('history-all').click();assert.equal(nodes.get('cases').children.length,9);
  nodes.get('cases').children[1].click();assert.equal(nodes.get('historyView').hidden,true);assert.equal(nodes.get('workspaceView').hidden,false);assert.equal(nodes.get('status').textContent,'Ready for support review');
  nodes.get('viewHistory').click();nodes.get('backToInbox').click();assert.equal(nodes.get('preparedList').children.length,1);assert.equal(requests.length,1);
});

test('submission removes only the submitted prepared email and preserves saved history',async()=>{
  const records=[saved];const data=()=>({...owner('ready',true),conversations:records});
  const {nodes,requests}=await page(null,{fetchResponse:async(path,options)=>{
    if(options?.method==='POST'){const value=JSON.parse(options.body);const record={...saved,id:value.event_id,subject:value.subject,messages:[{role:'customer',text:value.body}],status:'awaiting_review',draft:'Synthetic draft.'};records.unshift(record);return record;}return data();
  }});
  nodes.get('new').click();assert.equal(nodes.get('preparedList').children.length,2);await nodes.get('start').click();
  assert.equal(nodes.get('preparedList').children.length,1);assert.match(nodes.get('preparedList').textContent,/Maya/);
  assert.equal(nodes.get('cases').children.length,2);assert.equal(records[1],saved);assert.equal(nodes.get('status').textContent,'Ready for support review');
  assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.match(requests.find(r=>r.method==='POST').value.body,/Mia/);
});

test('failed submission keeps its prepared text and stable event ID for idempotent recovery',async()=>{
  const {nodes,requests}=await page(owner('ready',true),{fetchResponse:async(path,options)=>{if(options?.method==='POST')throw Error('Synthetic network failure');return owner('ready',true);}});
  await nodes.get('start').click();assert.equal(nodes.get('preparedList').children.length,1);assert.match(nodes.get('error').textContent,/network failure/);
  const first=requests.find(r=>r.method==='POST').value;await nodes.get('start').click();const posts=requests.filter(r=>r.method==='POST');
  assert.equal(posts.length,2);assert.deepEqual(posts[1].value,first);assert.equal(nodes.get('preparedList').children.length,1);
});

test('history defaults to today and older records remain intact behind explicit archive access',async()=>{
  const old={...saved,id:'older-synthetic',subject:'Archived test case',created_at:new Date(Date.now()-3*86400000).toISOString()};
  const data={...owner(),conversations:[saved,old]};const snapshot=JSON.stringify(data);
  const {nodes,requests}=await page(data);assert.match(nodes.get('viewHistory').textContent,/1 today/);
  nodes.get('viewHistory').click();assert.equal(nodes.get('cases').children.length,1);assert.doesNotMatch(nodes.get('cases').textContent,/Archived test case/);
  nodes.get('history-archive').click();assert.match(nodes.get('cases').textContent,/Archived test case/);assert.equal(nodes.get('cases').children.length,1);
  nodes.get('backToInbox').click();nodes.get('viewHistory').click();assert.doesNotMatch(nodes.get('cases').textContent,/Archived test case/);
  assert.equal(JSON.stringify(data),snapshot,'archive is a presentation filter, not a record mutation');assert.equal(requests.length,1);
});

test('owner workspace has no test cleanup controls and viewing saved records cannot delete them',async()=>{
  const data={...owner(),conversations:[{...saved,synthetic:true},{...saved,id:'another-synthetic',synthetic:true,status:'rejected'}]};
  const snapshot=JSON.stringify(data),{nodes,requests}=await page(data);
  assert.doesNotMatch(html,/Test history cleanup|Preview older records to delete|Permanently delete older tests/);
  assert.equal(nodes.has('cleanupPanel'),false);assert.equal(nodes.has('previewCleanup'),false);assert.equal(nodes.has('deleteCleanup'),false);
  nodes.get('viewHistory').click();nodes.get('cases').children[0].click();await nodes.get('refresh').click();
  nodes.get('viewAttention').click();nodes.get('cases').children[0].click();
  assert.equal(JSON.stringify(data),snapshot);assert.ok(requests.every(request=>request.method==='GET'));
  assert.equal(nodes.get('conversationPanel').hidden,false);assert.equal(nodes.get('status').textContent,'Rejected · not sent');
});

test('human attention includes explicit handoffs, rejected drafts and delivery exceptions across dates only',async()=>{
  const states=['human_required','rejected','delivery_failed','delivery_unknown','awaiting_review','awaiting_reply','approved','sent_test','model_paused','processing','sending'];
  const data={...owner(),conversations:states.map((status,i)=>({...saved,id:`attention-${i}`,subject:`Synthetic ${status}`,status,created_at:new Date(Date.now()-(i+2)*86400000).toISOString()}))};
  const snapshot=JSON.stringify(data);const {nodes,requests}=await page(data);
  assert.equal(nodes.get('viewAttention').textContent,'View queue (4)');
  nodes.get('viewAttention').click();
  assert.equal(nodes.get('workspaceView').hidden,true);assert.equal(nodes.get('historyView').hidden,false);
  assert.equal(nodes.get('historyTitle').textContent,'Needs human attention');assert.equal(nodes.get('cases').children.length,4);
  assert.equal(nodes.get('historyDateFilters').hidden,true);assert.equal(nodes.get('historyStatusFilters').hidden,true);
  assert.match(nodes.get('historyDateLabel').textContent,/All dates/);assert.match(nodes.get('historyDescription').textContent,/does not resolve.*assignment.*planned/);
  for(const status of states.slice(0,4))assert.match(nodes.get('cases').textContent,new RegExp(`Synthetic ${status}`));
  for(const status of states.slice(4))assert.ok(!nodes.get('cases').textContent.includes(`Synthetic ${status}`));
  nodes.get('cases').children[1].click();assert.equal(nodes.get('reviewBox').hidden,true);assert.equal(nodes.get('sendBox').hidden,true);assert.equal(nodes.get('approveV2').disabled,true);
  assert.match(nodes.get('nextStep').textContent,/rejected.*not sent/);assert.match(nodes.get('resultV2').textContent,/read-only/);
  nodes.get('viewAttention').click();nodes.get('cases').children[2].click();assert.equal(nodes.get('reconcileV2').hidden,false);
  nodes.get('viewAttention').click();nodes.get('cases').children[0].click();assert.equal(nodes.get('reviewBox').hidden,false);
  assert.equal(JSON.stringify(data),snapshot,'opening attention records does not mutate them');assert.equal(requests.length,1,'navigation makes no extra API or model calls');
});

test('attention entry shows an empty state and preserves pending edits across history and queue navigation',async()=>{
  const {nodes,requests}=await page(owner('ready',true));
  nodes.get('subjectV2').value='Unsaved synthetic title';nodes.get('subjectV2').listeners.input();nodes.get('bodyV2').value='Unsaved synthetic message';nodes.get('bodyV2').listeners.input();
  assert.equal(nodes.get('viewAttention').textContent,'View queue (0)');nodes.get('viewAttention').click();
  assert.equal(nodes.get('cases').children.length,0);assert.equal(nodes.get('emptyHistory').hidden,false);assert.match(nodes.get('emptyHistory').textContent,/No conversations need human attention/);
  nodes.get('backToInbox').click();assert.equal(nodes.get('subjectV2').value,'Unsaved synthetic title');assert.equal(nodes.get('bodyV2').value,'Unsaved synthetic message');
  nodes.get('viewHistory').click();assert.equal(nodes.get('historyTitle').textContent,'Conversation history');assert.equal(nodes.get('historyDateFilters').hidden,false);assert.equal(nodes.get('historyStatusFilters').hidden,false);assert.equal(nodes.get('cases').children.length,1);
  nodes.get('backToInbox').click();assert.equal(nodes.get('preparedList').children.length,1);assert.equal(requests.length,1);
});

test('attention counts follow saved status updates after refresh and reject without generating a new model request',async()=>{
  let records=[{...saved,status:'awaiting_review',draft:'Synthetic reply'}];
  const {nodes,requests}=await page(null,{fetchResponse:async(path,options)=>{
    if(options?.method==='POST'){
      assert.ok(path.endsWith('/review'));const value=JSON.parse(options.body);assert.equal(value.action,'reject');
      records=[{...records[0],status:'rejected',revision:10,review_history:[{action:'reject',note:value.note}]}];return records[0];
    }
    return{...owner('ready',true),conversations:records};
  }});
  nodes.get('cases').children[0].click();nodes.get('noteV2').value='Needs specialist follow-up';await nodes.get('rejectV2').click();
  await new Promise(setImmediate);
  assert.equal(nodes.get('viewAttention').textContent,'View queue (1)');nodes.get('viewAttention').click();assert.match(nodes.get('cases').textContent,/Rejected · not sent/);
  records=[{...records[0],status:'sent_test',revision:11}];await nodes.get('refresh').click();
  assert.equal(nodes.get('viewAttention').textContent,'View queue (0)');assert.equal(nodes.get('cases').children.length,0);
  const posts=requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/review'));
});
