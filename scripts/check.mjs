import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadKnowledge } from '../server/knowledge.mjs';
import { validate } from '../server/validation.mjs';

for (const directory of ['server', 'shared', 'share', 'cloud', 'scripts', 'public', 'tests']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', new URL(`../${directory}/${file}`, import.meta.url).pathname], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const corpus = await loadKnowledge();
const tickets = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
if (tickets.length !== 12 || new Set(tickets.map(ticket => ticket.id)).size !== 12) throw new Error('Expected twelve unique fixture IDs.');
for (const ticket of tickets) validate('input', { subject: ticket.subject, body: ticket.body, sample_id: ticket.id, synthetic: ticket.synthetic });
console.log(`Syntax and JSON contracts passed: ${corpus.articles.length} knowledge sources, ${tickets.length} synthetic cases.`);
