import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const html=await readFile(new URL('../public/training.html',import.meta.url),'utf8');
const code=await readFile(new URL('../public/training.js',import.meta.url),'utf8');
const collection=JSON.parse(await readFile(new URL('../public/training-cases.json',import.meta.url),'utf8'));
const knowledge=JSON.parse(await readFile(new URL('../data/knowledge.json',import.meta.url),'utf8'));
function element(tag='div'){
  return{tag,textContent:'',children:[],listeners:{},hidden:false,setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},append(...items){this.children.push(...items);this.textContent+=items.map(i=>i.textContent||'').join('');},replaceChildren(...items){this.children=items;this.textContent=items.map(i=>i.textContent||'').join('');},click(){return this.listeners.click?.();}};
}
async function page(data=collection,{ok=true,failure=false}={}){
  const nodes=new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([,tag,id])=>[id,element(tag)]));
  const requests=[];
  runInNewContext(code,{document:{getElementById:id=>nodes.get(id),createElement:element},location:{hostname:'example.chatgpt.site'},fetch:async(path,options)=>{requests.push({path,...options});if(failure)throw Error('Connection unavailable');return{ok,json:async()=>data};}});
  await new Promise(setImmediate);return{nodes,requests};
}
test('ten curated training cases have distinct scenarios, complete review notes and exact official source references',()=>{
  assert.equal(collection.cases.length,10);assert.equal(new Set(collection.cases.map(c=>c.id)).size,10);
  assert.equal(new Set(collection.cases.map(c=>c.subject)).size,10);assert.equal(collection.knowledgeVersion,knowledge.version);
  for(const source of collection.sources){const official=knowledge.articles.find(s=>s.id===source.id&&s.active);assert.ok(official);assert.equal(source.title,official.title);assert.equal(source.url,official.url);}
  assert.match(collection.notice,/written teaching examples.*not saved.*live AI outputs/);
  for(const c of collection.cases){assert.ok(c.flow.length>=4&&c.reviewerChecks.length>=2&&c.expectedResponse&&c.explanation);for(const id of c.sourceIds)assert.ok(collection.sources.some(s=>s.id===id));}
  assert.match(collection.cases[0].expectedResponse,/does not save automatically.*Weekly Timesheet Entry.*not checked/s);
  const gap=collection.cases.find(c=>c.id==='TRAIN-009');assert.ok(gap);assert.match(gap.outcome,/person|human/i);
});
test('training navigation renders all expected outcomes from one static file without API, storage or model access',async()=>{
  const snapshot=JSON.stringify(collection);const {nodes,requests}=await page();
  assert.equal(nodes.get('trainingContent').hidden,false);assert.equal(nodes.get('trainingList').children.length,10);
  for(let i=0;i<10;i++){
    nodes.get('trainingList').children[i].click();const example=collection.cases[i];
    assert.equal(nodes.get('trainingTitle').textContent,example.title);assert.equal(nodes.get('trainingEmail').textContent,example.email);assert.equal(nodes.get('trainingResponse').textContent,example.expectedResponse);
    assert.equal(nodes.get('trainingList').children[i]['aria-current'],'true');assert.equal(nodes.get('trainingFlow').children.length,example.flow.length);
    if(example.sourceIds.length){const link=nodes.get('trainingSources').children[0].children[0];assert.equal(link.href,collection.sources.find(s=>s.id===example.sourceIds[0]).url);assert.equal(link.rel,'noopener noreferrer');}
    else assert.match(nodes.get('trainingSources').textContent,/No article is used/);
  }
  assert.deepEqual(requests,[{path:'/training-cases.json',cache:'no-store'}]);assert.equal(JSON.stringify(collection),snapshot);
  assert.doesNotMatch(html,/id="(?:start|approveV2|sendV2|analyseButton)"|conversation-engine\.js|conversation\.js/);
});
for(const variant of ['network','missing','malformed','unsafe-source'])test(`training ${variant} failure is visible and never falls back to generation`,async()=>{
  const value=structuredClone(collection);if(variant==='malformed')value.cases[0].sourceIds=['K-999'];if(variant==='unsafe-source')value.sources[0].url='https://untrusted.example/';
  const {nodes,requests}=await page(value,{ok:variant!=='missing',failure:variant==='network'});
  assert.equal(nodes.get('trainingContent').hidden,true);assert.equal(nodes.get('trainingError').hidden,false);assert.match(nodes.get('trainingNotice').textContent,/No model request/);assert.equal(requests.length,1);
});
test('training text is rendered literally without executing embedded markup',async()=>{
  const value=structuredClone(collection);value.cases[0].expectedResponse='<img src=x onerror=alert(1)>';
  const {nodes}=await page(value);assert.equal(nodes.get('trainingResponse').textContent,value.cases[0].expectedResponse);assert.equal(nodes.get('trainingResponse').children.length,0);
});
