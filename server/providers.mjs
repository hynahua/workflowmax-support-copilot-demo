import { AppError } from './errors.mjs';
export { rehearsalProvider } from '../shared/rehearsal.mjs';

export function unconfiguredProvider() {
  return {
    mode: 'not_connected', model: null,
    async generate() {
      throw new AppError('MODEL_NOT_CONNECTED', 'Live AI is disabled in this process. Use an explicit live command within an approved usage plan, or start rules rehearsal without API calls.', 503);
    }
  };
}
