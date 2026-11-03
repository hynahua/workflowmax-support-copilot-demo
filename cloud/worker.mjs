import { assets, corpus, contracts, prompts } from '#cloud-data';
import * as validators from '#share-validators';
import { openaiProvider } from '../server/openai-provider.mjs';
import { boundedLiveProvider } from '../shared/live-budget.mjs';
import { ConversationService } from '../shared/conversation-service.mjs';
import { conversationRoute } from '../server/conversation-http.mjs';
import { AppError, publicError } from '../server/errors.mjs';
import { D1Store } from './d1-store.mjs';
const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
export default { async fetch(request,env) {
  const url = new URL(request.url);
  let access = { status: 'signed_out' };
  try {
    if (request.method === 'GET' && assets[url.pathname]) { const asset=assets[url.pathname]; return new Response(asset.body,{headers:{...headers,'Content-Type':asset.type}}); }
    if (!url.pathname.startsWith('/api/live/conversations') && url.pathname !== '/api/live/model-session') return json({error:{code:'NOT_FOUND',message:'Route not found.'}},404);
    const userId=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');
    // Sites injects authenticated identity; a public audience alone never grants paid API use.
    if (!userId || !email) throw new AppError('LIVE_SIGN_IN_REQUIRED','Sign in with ChatGPT to view the owner workspace. Public visitors can use rules rehearsal.',401);
    access = { status: 'not_authorized' };
    if (!env.LIVE_OPERATOR_EMAIL || email.toLowerCase() !== env.LIVE_OPERATOR_EMAIL.toLowerCase()) throw new AppError('LIVE_FORBIDDEN','This signed-in account cannot access the owner workspace. Choose the authorized owner account, or use public rules rehearsal.',403);
    access = { status: 'signed_in', role: 'owner' };
    if (!env.DB) throw new AppError('STORAGE_UNAVAILABLE','Durable cloud storage is not configured. No model request was made.',503);
    let grant;try { grant=JSON.parse(env.LIVE_APPROVED_PLAN || 'null'); } catch { grant=null; }
    const store=new D1Store(env.DB,`owner:${userId}`);
    const budgetStore=new D1Store(env.DB,'global-live-budget');
    const configured = !!env.OPENAI_API_KEY;
    const base = configured ? openaiProvider({apiKey:env.OPENAI_API_KEY}) : {mode:'not_connected',model:null,async generate(){throw new AppError('MODEL_SESSION_UNAVAILABLE','Model access is unavailable. No request was made.',503);}};
    const provider = boundedLiveProvider(base,{store:budgetStore,grant,configured,allowContinuation:grant?.id==='demo-parent-session',carryForwardBudgetId:grant?.id==='demo-practice-session'?'demo-parent-session--manual-continuation':null});
    const validate=(name,value)=>{if(!validators[name](value))throw new AppError('SCHEMA_INVALID',`Invalid ${name} output.`,400);};
    const service=new ConversationService({store,provider,corpus,contracts,prompts,validate});
    let value=null;
    if(request.method==='POST'){
      if(request.headers.get('Origin')!==url.origin || request.headers.get('Sec-Fetch-Site')==='cross-site')throw new AppError('ORIGIN_REJECTED','Only same-origin workspace actions are accepted.',403);
      if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new AppError('JSON_REQUIRED','Send JSON.',415);
      const reader=request.body?.getReader(); const chunks=[];let size=0;
      if(!reader)throw new AppError('JSON_INVALID','A JSON body is required.',400);
      for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>16384){await reader.cancel();throw new AppError('INPUT_TOO_LARGE','Request exceeds the demonstration limit.',413);}chunks.push(chunk.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AppError('JSON_INVALID','Invalid JSON body.',400);}
    }
    const result=await conversationRoute(url.pathname.replace('/api/live/','/api/'),request.method,value,service);
    return json(url.pathname==='/api/live/conversations'&&request.method==='GET'?{...result,cloud:true,access,live_available:configured && result.generation_enabled}:result);
  }catch(error){return json({error:publicError(error),access},error instanceof AppError?error.status:500);}
} };
