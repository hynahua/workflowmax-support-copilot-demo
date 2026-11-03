import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validate } from './validation.mjs';
import { ConversationService } from '../shared/conversation-service.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
export async function conversationConfig() {
  const contracts = {}, prompts = {}; contracts.provenance = {}; prompts.provenance = {};
  for (const phase of ['triage', 'draft']) {
    const schemaText = await readFile(new URL(`../schemas/${phase}.schema.json`, import.meta.url), 'utf8');
    contracts[phase] = JSON.parse(schemaText); contracts.provenance[phase] = digest(schemaText);
    prompts[phase] = await readFile(new URL(`../prompts/${phase}-v2.md`, import.meta.url), 'utf8'); prompts.provenance[phase] = digest(prompts[phase]);
  }
  return { contracts, prompts, validate };
}
export async function createConversationService(options) { return new ConversationService({ ...await conversationConfig(), ...options }); }
