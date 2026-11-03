import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validate } from './validation.mjs';
import { AppError } from './errors.mjs';

export { words, retrieve, relevantFacts } from '../shared/knowledge.mjs';

export async function loadKnowledge(file = new URL('../data/knowledge.json', import.meta.url)) {
  const raw = await readFile(file, 'utf8');
  const corpus = validate('knowledge', JSON.parse(raw));
  if (new Set(corpus.articles.map(article => article.id)).size !== corpus.articles.length) {
    throw new AppError('KNOWLEDGE_INVALID', 'Knowledge IDs must be unique.', 503);
  }
  return { ...corpus, hash: createHash('sha256').update(raw).digest('hex') };
}
