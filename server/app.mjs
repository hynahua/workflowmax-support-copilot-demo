import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { analyse, promptVersion } from './workflow.mjs';
import { AppError, publicError } from './errors.mjs';
import { validate } from './validation.mjs';
import { conversationRoute } from './conversation-http.mjs';

const assets = { '/legacy': ['index.html', 'text/html; charset=utf-8'], '/conversation.js': ['conversation.js', 'text/javascript; charset=utf-8'], '/': ['training.html', 'text/html; charset=utf-8'], '/training': ['training.html', 'text/html; charset=utf-8'], '/practice': ['conversation.html', 'text/html; charset=utf-8'], '/training.js': ['training.js', 'text/javascript; charset=utf-8'], '/training-cases.json': ['training-cases.json', 'application/json; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON_REQUIRED', 'Send JSON data.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size <= 16384) chunks.push(chunk); }
  if (size > 16384) throw new AppError('INPUT_TOO_LARGE', 'The request is too large for this demo.', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('JSON_INVALID', 'The request was not valid JSON.', 400); }
}

export function createApp({ corpus, provider, store, tickets, conversations }) {
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new AppError('HOST_REJECTED', 'Use the local loopback address printed by the server.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError('ORIGIN_REJECTED', 'Only requests from this local workspace are accepted.', 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path.startsWith('/api/conversations') && conversations) { send(res, 200, await conversationRoute(path, req.method, req.method === 'POST' ? await body(req) : null, conversations)); return; }
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        const content = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
      if (req.method === 'GET' && path === '/api/bootstrap') {
        send(res, 200, {
          mode: provider.mode, model: provider.model, knowledge_version: corpus.version, prompt_version: promptVersion,
          articles: corpus.articles,
          tickets: tickets.map(({ expected, ...ticket }) => ticket),
          runs: (await store.list()).slice(0, 30)
        }); return;
      }
      if (req.method === 'POST' && path === '/api/analyse') {
        if (provider.mode === 'live_ai') throw new AppError('LEGACY_LIVE_DISABLED', 'Use the budgeted two-stage conversation workflow. Historical one-stage live generation is disabled.', 403);
        const input = validate('input', await body(req));
        if (input.sample_id && !tickets.some(ticket => ticket.id === input.sample_id && ticket.subject === input.subject && ticket.body === input.body)) throw new AppError('SAMPLE_MISMATCH', 'Edited text must be labelled as a custom synthetic email, not as an unchanged sample.', 400);
        const run = await analyse(input, { corpus, provider });
        await store.create(run); send(res, 200, run); return;
      }
      const review = path.match(/^\/api\/runs\/([a-f0-9-]{36})\/review$/);
      if (req.method === 'POST' && review) {
        const value = await body(req);
        const previous = await store.get(review[1]);
        if (value.action === 'approve' && previous && (previous.knowledge_hash !== corpus.hash || previous.knowledge_version !== corpus.version)) throw new AppError('KNOWLEDGE_CHANGED', 'The knowledge collection changed after this run. Analyse it again before approval.', 409);
        send(res, 200, await store.review(review[1], value)); return;
      }
      const record = path.match(/^\/api\/runs\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && record) {
        const run = await store.get(record[1]); if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
        send(res, 200, run); return;
      }
      throw new AppError('NOT_FOUND', 'This route does not exist. Only the synthetic test transport is supported.', 404);
    } catch (error) { send(res, error instanceof AppError ? error.status : 500, { error: publicError(error) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
