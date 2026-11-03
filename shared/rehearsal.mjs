import { relevantFacts } from './knowledge.mjs';
import { acknowledgement, intentLabels, riskFloor } from '../server/routing.mjs';

// Explicitly a deterministic workflow rehearsal, never a model-quality result.
export function rehearsalProvider() {
  return {
    mode: 'rules_rehearsal', model: 'deterministic-rehearsal-v1',
    async generate({ input, sources }) {
      const flags = riskFloor(input);
      const route = flags.length ? 'escalate' : sources.length ? 'draft' : 'clarify';
      const source = sources[0];
      const draft = route === 'draft'
        ? `Thanks for your question. The reviewed help article offers the following guidance:\n\n${relevantFacts(input, source).map(fact => `• ${fact}`).join('\n')}\n\nReference: ${source.title} [${source.id}]. Please confirm these conditions fit your situation before following the guidance.`
        : acknowledgement(route);
      return {
        summary: `Review the request: ${input.subject}`,
        intents: intentLabels(input, flags), risk_flags: flags, route,
        reason: 'Deterministic rehearsal uses keyword signals and curated facts. It is not live AI analysis or a calibrated classifier.',
        draft, citation_ids: source ? [source.id] : []
      };
    }
  };
}
