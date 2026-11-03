import { mkdir, readFile, writeFile, readdir, lstat, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = new URL('../', import.meta.url);
const checkout = new URL('cloud-site/', root);
const dist = new URL('dist/', checkout);
await mkdir(dist, { recursive: true });
for (const file of await readdir(dist)) if (!['index.html', 'styles.css', 'app.js', 'demo-engine.js', 'conversation.html', 'conversation.js', 'conversation-engine.js', 'training.html', 'training.js', 'training-cases.json', 'server', '.openai'].includes(file)) throw new Error(`Unexpected sharing asset: ${file}. Nothing has been deleted or uploaded.`);
const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true, esm: true } });
for (const name of ['input', 'analysis', 'review', 'knowledge', 'triage', 'draft']) ajv.addSchema(JSON.parse(await readFile(new URL(`schemas/${name}.schema.json`, root), 'utf8')));
const validatorsPath = new URL('generated-validators.mjs', checkout);
await writeFile(validatorsPath, standaloneCode(ajv, { input: 'input', analysis: 'analysis', review: 'review', knowledge: 'knowledge', triage: 'triage', draft: 'draft' }));
const knowledgeText = await readFile(new URL('data/knowledge.json', root), 'utf8');
const corpus = { ...JSON.parse(knowledgeText), hash: createHash('sha256').update(knowledgeText).digest('hex') };
const tickets = JSON.parse(await readFile(new URL('data/tickets.json', root), 'utf8')).map(({ expected, ...ticket }) => ticket);
const provenance = { edition: 'cloud-browser-rehearsal-v1', prompt_version: 'support-reviewer-v1', prompt_hash: createHash('sha256').update(await readFile(new URL('prompts/support-reviewer.md', root))).digest('hex') };
const dataPath = new URL('generated-data.mjs', checkout);
await writeFile(dataPath, `export const corpus=${JSON.stringify(corpus)};\nexport const tickets=${JSON.stringify(tickets)};\nexport const provenance=${JSON.stringify(provenance)};\n`);
const result = await build({
  entryPoints: [fileURLToPath(new URL('share/browser-entry.mjs', root))], outfile: fileURLToPath(new URL('demo-engine.js', dist)),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: false, metafile: true,
  alias: { '#share-validators': fileURLToPath(validatorsPath), '#share-data': fileURLToPath(dataPath) },
  legalComments: 'inline',
  banner: { js: `/* Ajv runtime helper license:\n${await readFile(new URL('node_modules/ajv/LICENSE', root), 'utf8')}\n*/` }
});
const bundle = await readFile(new URL('demo-engine.js', dist), 'utf8');
if (/api\.openai\.com|OPENAI_API_KEY|node:|workflowmax-interview-materials|source_repository_credential/.test(bundle)) throw new Error('The browser bundle contains an excluded dependency or credential marker.');
if (Object.keys(result.metafile.inputs).some(name => /(?:openai-provider|live-config|server\/workflow|server\/store|data\/tickets\.json)/.test(name))) throw new Error('An excluded server or expectation source entered the sharing bundle.');
let html = await readFile(new URL('public/index.html', root), 'utf8');
html = html.replace('<script defer src="./app.js"></script>', '<script defer src="./demo-engine.js"></script>\n  <script defer src="./app.js"></script>');
html = html.replace('<meta name="description"', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'none\'; img-src \'self\' data:; base-uri \'none\'; form-action \'none\'">\n  <meta name="description"');
html = html.replaceAll('saved on this computer', 'saved only in this browser').replaceAll('This records your decision locally.', 'This saves a demonstration decision in this browser only.').replace('Local records', 'Browser-only records');
await writeFile(new URL('index.html', dist), html);
for (const name of ['styles.css', 'app.js']) await writeFile(new URL(name, dist), await readFile(new URL(`public/${name}`, root)));
await writeFile(new URL('package.json', checkout), `${JSON.stringify({ name: 'support-lab-cloud-rehearsal', version: '0.1.0', private: true }, null, 2)}\n`);
await writeFile(new URL('README.md', checkout), '# Support Lab cloud rehearsal\n\nSanitized static demonstration: public knowledge, synthetic emails, deterministic rules, browser-local review records. No model, key, private source materials, prior runtime history, shared database or email sending.\n');
await writeFile(new URL('.gitignore', checkout), 'node_modules/\n.sites-runtime/\n.DS_Store\n');
for (const name of await readdir(dist)) if (!['server','.openai'].includes(name) && !(await lstat(new URL(name, dist))).isFile()) throw new Error('Sharing assets must be regular files.');
console.log(`Prepared legacy browser rehearsal: ${tickets.length} synthetic cases and ${corpus.articles.length} public sources, no model endpoint or credentials in client assets.`);
console.log(`Static assets: ${fileURLToPath(dist)}`);

// v2 server artifact: assets and approved code only; never copy the root checkout.
const contracts = { provenance: {} }, prompts = { provenance: {} };
for (const phase of ['triage','draft']) {
  const text = await readFile(new URL(`schemas/${phase}.schema.json`,root),'utf8');
  contracts[phase] = JSON.parse(text); contracts.provenance[phase] = createHash('sha256').update(text).digest('hex');
  prompts[phase] = await readFile(new URL(`prompts/${phase}-v2.md`,root),'utf8'); prompts.provenance[phase] = createHash('sha256').update(prompts[phase]).digest('hex');
}
const conversationData = new URL('generated-conversation-data.mjs',checkout);
await writeFile(conversationData,`export const corpus=${JSON.stringify(corpus)};export const contracts=${JSON.stringify(contracts)};export const prompts=${JSON.stringify(prompts)};`);
await build({entryPoints:[fileURLToPath(new URL('share/conversation-browser.mjs',root))],outfile:fileURLToPath(new URL('conversation-engine.js',dist)),bundle:true,platform:'browser',format:'iife',target:['es2022'],alias:{'#share-validators':fileURLToPath(validatorsPath),'#conversation-data':fileURLToPath(conversationData)},banner:{js:`/* Ajv runtime helper license:\n${await readFile(new URL('node_modules/ajv/LICENSE',root),'utf8')}\n*/`}});
const browserBundle = await readFile(new URL('conversation-engine.js',dist),'utf8');
if (/api\.openai\.com|OPENAI_API_KEY|node:|workflowmax-interview-materials|source_repository_credential/.test(browserBundle)) throw Error('Excluded material entered the v2 browser bundle.');
let conversationHtml = await readFile(new URL('public/conversation.html',root),'utf8');
conversationHtml = conversationHtml.replace('<script defer src="/conversation.js"></script>','<script defer src="/conversation-engine.js"></script><script defer src="/conversation.js"></script>');
await writeFile(new URL('conversation.html',dist),conversationHtml);
await writeFile(new URL('conversation.js',dist),await readFile(new URL('public/conversation.js',root)));
for (const name of ['training.html', 'training.js', 'training-cases.json']) await writeFile(new URL(name, dist), await readFile(new URL(`public/${name}`, root)));
const assets = {};
for (const [path,name,type] of [['/','training.html','text/html; charset=utf-8'],['/training','training.html','text/html; charset=utf-8'],['/training.js','training.js','text/javascript; charset=utf-8'],['/training-cases.json','training-cases.json','application/json; charset=utf-8'],['/practice','conversation.html','text/html; charset=utf-8'],['/live','conversation.html','text/html; charset=utf-8'],['/legacy','index.html','text/html; charset=utf-8'],['/styles.css','styles.css','text/css; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/demo-engine.js','demo-engine.js','text/javascript; charset=utf-8'],['/conversation.js','conversation.js','text/javascript; charset=utf-8'],['/conversation-engine.js','conversation-engine.js','text/javascript; charset=utf-8']]) assets[path] = {body:await readFile(new URL(name,dist),'utf8'),type};
const workerData = new URL('generated-worker-data.mjs',checkout);
await writeFile(workerData,`export const assets=${JSON.stringify(assets)};export const corpus=${JSON.stringify(corpus)};export const contracts=${JSON.stringify(contracts)};export const prompts=${JSON.stringify(prompts)};`);
await mkdir(new URL('worker/',checkout),{recursive:true});
const workerResult = await build({entryPoints:[fileURLToPath(new URL('cloud/worker.mjs',root))],outfile:fileURLToPath(new URL('worker/index.js',checkout)),bundle:true,platform:'browser',format:'esm',target:['es2022'],metafile:true,alias:{'#share-validators':fileURLToPath(validatorsPath),'#cloud-data':fileURLToPath(workerData)},banner:{js:`/* Ajv runtime helper license:\n${await readFile(new URL('node_modules/ajv/LICENSE',root),'utf8')}\n*/`}});
if(Object.keys(workerResult.metafile.inputs).some(name=>/live-config|conversation-store|data\/tickets\.json|materials\//.test(name)))throw Error('Private or local-only source entered the Worker.');
const manifestPath=new URL('.openai/hosting.json',checkout);
let manifest;
try { manifest=JSON.parse(await readFile(manifestPath,'utf8')); }
catch(error) { if(error.code!=='ENOENT') throw error; manifest={d1:'DB',r2:null}; }
// An operator configures their own Site identity before publication. No publisher identity ships here.
if(manifest.project_id !== undefined && (typeof manifest.project_id !== 'string' || !manifest.project_id.trim())) throw Error('Invalid operator Site identity.');
delete manifest.static;manifest.d1='DB';manifest.r2??=null;
await mkdir(new URL('.openai/',checkout),{recursive:true});
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
await cp(new URL('cloud/drizzle/',root),new URL('drizzle/',checkout),{recursive:true});
await mkdir(new URL('scripts/',checkout),{recursive:true});
await writeFile(new URL('scripts/build.mjs',checkout),`import {mkdir,copyFile,cp} from 'node:fs/promises';await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});await copyFile('worker/index.js','dist/server/index.js');await copyFile('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/.openai/drizzle',{recursive:true});console.log('Worker artifact built.');\n`);
await writeFile(new URL('package.json',checkout),JSON.stringify({name:'support-lab-cloud-conversation',version:'0.2.0',private:true,type:'module',scripts:{build:'node scripts/build.mjs','db:check':'node --check worker/index.js'}},null,2)+'\n');
await writeFile(new URL('README.md',checkout),'# Support Lab cloud conversation\n\nOperator-configured Site and audience. Embedded static rules rehearsal uses visitor-browser storage. /live uses owner-authorized server identity, runtime secrets, a separately approved bounded grant, D1 state and a durable TEST outbox. Default cloud live is disabled. No actual mailbox, local history, credential or private case material is included. worker/index.js is the self-contained sanitized source artifact generated from the project allowlist; npm run build emits Worker ESM plus schema-only D1 migrations.\n');
await mkdir(new URL('server/',dist),{recursive:true});await mkdir(new URL('.openai/',dist),{recursive:true});
await writeFile(new URL('server/index.js',dist),await readFile(new URL('worker/index.js',checkout)));
await writeFile(new URL('.openai/hosting.json',dist),JSON.stringify(manifest,null,2)+'\n');
await cp(new URL('cloud/drizzle/',root),new URL('.openai/drizzle/',dist),{recursive:true});
console.log('Prepared same-Site Worker with D1, owner-only live API and default-closed grant. Browser bundles contain no model adapter or secret.');
