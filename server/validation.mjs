import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {};
for (const name of ['input', 'analysis', 'review', 'knowledge', 'triage', 'draft']) {
  const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  validators[name] = ajv.compile(schema);
}

export function validate(name, value) {
  const validator = validators[name];
  if (!validator) throw new Error('Unknown validation contract');
  if (!validator(value)) {
    const detail = validator.errors.map(error => `${error.instancePath || '/'} ${error.message}`).slice(0, 4).join('; ');
    throw new AppError('SCHEMA_INVALID', `Invalid ${name}: ${detail}`, 400);
  }
  return value;
}

export function validateAnalysis(value, sources) {
  validate('analysis', value);
  const allowed = new Set(sources.map(source => source.id));
  if (value.citation_ids.some(id => !allowed.has(id))) {
    throw new AppError('UNKNOWN_CITATION', 'The response cited a source outside the active retrieved evidence.');
  }
  if (value.route === 'draft' && (!value.citation_ids.length || !value.draft.trim())) {
    throw new AppError('UNSUPPORTED_DRAFT', 'A product draft needs retrieved evidence and non-empty text.');
  }
  return value;
}
