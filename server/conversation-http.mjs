import { AppError } from './errors.mjs';
export async function conversationRoute(path, method, value, service) {
  if (path === '/api/model-session' && method === 'GET') return service.availability();
  if (path === '/api/model-session' && method === 'POST') return service.setModelEnabled(value);
  if (path === '/api/conversations' && method === 'GET') return { conversations: await service.list(), mode: service.provider.mode, model: service.provider.model, generation_enabled: (await service.availability()).enabled, budget: await service.availability(), transport: 'test_only', workflow_version: 'conversation-v2' };
  if (path === '/api/conversations' && method === 'POST') return service.create(value);
  const match = path.match(/^\/api\/conversations\/([\da-f-]{36})(?:\/(reply|review|send|reconcile|resume))?$/);
  if (!match) throw new AppError('NOT_FOUND', 'Conversation route not found.', 404);
  if (method === 'GET' && !match[2]) return service.get(match[1]);
  if (method === 'POST' && match[2]) return service[match[2]](match[1], value);
  throw new AppError('NOT_FOUND', 'Conversation route not found.', 404);
}
