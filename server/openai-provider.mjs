import contract from '../schemas/analysis.schema.json' with { type: 'json' };
import { AppError } from './errors.mjs';

export const liveModel = 'gpt-6-luna';
export const maxOutputTokens = 1800;
const endpoint = 'https://api.openai.com/v1/responses';
// Keep the full Ajv contract locally; send a smaller strict-schema subset to the API.
function responseSchema(value) {
  if (Array.isArray(value)) return value.map(responseSchema);
  if (!value || typeof value !== 'object') return value;
  const projected = Object.fromEntries(Object.entries(value).filter(([key]) => !['$schema', '$id', 'uniqueItems'].includes(key)).map(([key, item]) => [key, responseSchema(item)]));
  if (projected.enum && !projected.type) projected.type = 'string';
  return projected;
}
const schema = responseSchema(contract);

function httpError(status, code) {
  if (status === 401) return new AppError('MODEL_AUTH_FAILED', 'The API key is invalid or expired. Update the approved local key and restart the live service.', 503);
  if (status === 403) return new AppError('MODEL_ACCESS_DENIED', 'This API project cannot access the model. Check project permissions before retrying.', 503);
  if (status === 429) return new AppError(code === 'insufficient_quota' ? 'MODEL_QUOTA_EXHAUSTED' : 'MODEL_RATE_LIMITED', 'The API quota or rate limit prevented analysis. Check the account state before a deliberate retry; no automatic retry was made.', 503);
  return new AppError('MODEL_REQUEST_FAILED', `The model request failed (HTTP ${status}). No usable draft was returned and no automatic retry was made.`, 503);
}

async function readResponse(response) {
  const chunks = []; let size = 0;
  if (!response.body) throw new AppError('MODEL_RESPONSE_INVALID', 'The model returned an empty response.', 503);
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 262144) throw new AppError('MODEL_RESPONSE_INVALID', 'The model response exceeded the local response-size limit.', 503);
    chunks.push(chunk);
  }
  try { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AppError('MODEL_RESPONSE_INVALID', 'The model service did not return usable JSON.', 503); }
}

function metadataOf(data) {
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : null;
  return {
    response_id: identifier(data.id), actual_model: identifier(data.model),
    input_tokens: tokenCount(data.usage?.input_tokens), output_tokens: tokenCount(data.usage?.output_tokens),
    cached_input_tokens: tokenCount(data.usage?.input_tokens_details?.cached_tokens),
    max_output_tokens: maxOutputTokens, store: false
  };
}

export function openaiProvider({ apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new AppError('MODEL_KEY_MISSING', 'A usable server-side OPENAI_API_KEY is required for live mode.', 503);
  const key = apiKey.trim();
  return {
    mode: 'live_ai', model: liveModel,
    async generate({ input, sources = [], instructions, signal, onMetadata, onOutput, phase, contract: phaseContract, context, triage, feedback }) {
      const selectedSchema = phaseContract ? responseSchema(phaseContract) : schema;
      const evidence = sources.map(({ id, title, url, facts, conditions, reviewed_at }) => ({ id, title, url, facts, conditions, reviewed_at }));
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'manual', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: liveModel, instructions,
            input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ synthetic_email: { subject: input.subject, body: input.body }, retrieved_evidence: evidence, ...(phase ? { phase, conversation: context, triage, repair_feedback: feedback } : {}) }) }] }],
            reasoning: { effort: 'none' }, max_output_tokens: maxOutputTokens, store: false,
            text: { format: { type: 'json_schema', name: phase ? `support_${phase}_v2` : 'support_analysis', strict: true, schema: selectedSchema } }
          })
        });
      } catch {
        throw new AppError('MODEL_NETWORK_FAILED', 'The model service could not be reached. No automatic retry was made; check connectivity before retrying.', 503);
      }
      if (response.status >= 300 && response.status < 400) throw new AppError('MODEL_REDIRECT_REJECTED', 'The fixed model endpoint returned a redirect. It was not followed; no credentials were forwarded.', 503);
      // Never expose provider error bodies: they may repeat request or account data.
      let data;
      try { data = await readResponse(response); }
      catch (error) {
        if (!response.ok) throw httpError(response.status);
        if (error instanceof AppError) throw error;
        throw new AppError('MODEL_NETWORK_FAILED', 'The model response could not be read. No automatic retry was made.', 503);
      }
      if (!response.ok) throw httpError(response.status, data?.error?.code);
      if (!data || typeof data !== 'object') throw new AppError('MODEL_RESPONSE_INVALID', 'The model response has an invalid shape.', 503);
      onMetadata?.(metadataOf(data));
      if (data.status !== 'completed') throw new AppError('MODEL_INCOMPLETE', 'The model did not complete a response. No partial draft is available for approval.', 503);
      const output = Array.isArray(data.output) ? data.output : [];
      const content = output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => Array.isArray(item.content) ? item.content : []);
      if (content.some(item => item.type === 'refusal')) throw new AppError('MODEL_REFUSED', 'The model declined this request. A person should handle it.', 503);
      const text = content.filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
      if (!text.trim()) throw new AppError('MODEL_RESPONSE_INVALID', 'The model returned no analysis text.', 503);
      try { const value = JSON.parse(text); onOutput?.(value); return value; }
      catch { onOutput?.(text); throw new AppError(phase ? 'MODEL_OUTPUT_JSON' : 'MODEL_RESPONSE_INVALID', 'The model analysis was not valid JSON. No draft is available for approval.', 503); }
    }
  };
}
