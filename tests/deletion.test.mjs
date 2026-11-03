import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationRoute } from '../server/conversation-http.mjs';

test('retired cleanup routes return not found without reaching a service operation', async () => {
  const service = new Proxy({}, { get() { assert.fail('Retired cleanup routes must not access service operations.'); } });
  for (const path of ['/api/conversations/cleanup-preview', '/api/conversations/cleanup']) {
    for (const method of ['GET', 'POST']) {
      await assert.rejects(conversationRoute(path, method, { confirmed: true, keep_case_id: 'synthetic-case', expected_revision: 0, preview_token: 'a'.repeat(64) }, service), { code: 'NOT_FOUND', status: 404 });
    }
  }
});
