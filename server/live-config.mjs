import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { openaiProvider } from './openai-provider.mjs';

export function configuredLiveProvider({ envFile = new URL('../.env.local', import.meta.url), fetchImpl } = {}) {
  // The file is read only after an explicit live command. Never source it as shell code.
  // Use the approved workspace destination, never a key inherited from another tool.
  let values;
  try { values = parseEnv(readFileSync(envFile, 'utf8')); }
  catch { throw new Error('Unable to load the approved .env.local file. Check its presence and format without displaying the key.'); }
  return openaiProvider({ apiKey: values.OPENAI_API_KEY, fetchImpl });
}
