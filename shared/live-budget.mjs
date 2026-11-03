import { AppError } from '../server/errors.mjs';
export const maxInputBytes = 12000;
export const requestReserveUsd = 0.0025;
export const maxGrantRequests = 1000;
export const maxGrantUsd = 10;
function requestLimitExtensionShape(grant) {
  if (!Object.hasOwn(grant, 'request_limit_extension')) return true;
  const extension = grant.request_limit_extension;
  return !!(extension && typeof extension === 'object' && !Array.isArray(extension) && Object.keys(extension).length === 2 && extension.authorization === 'request-cap-extension-v1' && extension.from_max_requests === 30 && grant.id === 'demo-session' && grant.max_requests === 60);
}
export function grantShape(grant) {
  return !!(grant && typeof grant.id === 'string' && /^[\w-]{1,100}$/.test(grant.id) && Number.isInteger(grant.max_requests) && grant.max_requests > 0 && grant.max_requests <= maxGrantRequests && typeof grant.max_usd === 'number' && Number.isFinite(grant.max_usd) && grant.max_usd > 0 && grant.max_usd <= maxGrantUsd && typeof grant.expires_at === 'string' && Number.isFinite(Date.parse(grant.expires_at)) && requestLimitExtensionShape(grant));
}
export function validGrant(grant) { return grantShape(grant) && Date.parse(grant.expires_at) > Date.now(); }
const reasons = {
  no_active_grant: 'No authorized model session is available.', expired: 'The original authorization has expired. Turning the switch on cannot extend it.',
  closed: 'This historical one-case batch is closed and cannot be reopened by the switch.', faulted: 'This session stopped after a provider failure. The switch cannot retry or bypass that stop.',
  exhausted: 'The authorized request or conservative cost limit has been reached.', unavailable: 'Model access is unavailable. Saved records remain available.',
  off: 'Model is OFF. Turn it on to allow new requests within the remaining session allowance.', ready: 'Model is ON. Only submitted emails, replies or explicit resumes request a model; idle pages make no model calls.'
};
export function boundedLiveProvider(provider, { store, grant, strategy = 'manual', configured = true, allowContinuation = false, carryForwardBudgetId = null }) {
  const manual = strategy === 'manual';
  async function extendRequestLimit(session, budgetId, row) {
    const extension = grant.request_limit_extension;
    if (!extension) return row;
    const invalid = () => { throw new AppError('REQUEST_LIMIT_EXTENSION_INVALID', 'The authorized request-limit extension could not be verified. Saved use and model controls were not reset.', 503); };
    const value = row?.value, audits = value?.request_limit_extensions;
    if (!manual || !session || budgetId !== grant.id || !value || !Number.isSafeInteger(value.requests) || value.requests < 0 || !Number.isFinite(value.reserved_usd) || value.reserved_usd < 0 || value.reserved_usd > grant.max_usd || (audits !== undefined && !Array.isArray(audits))) invalid();
    if (JSON.stringify(value.grant) === JSON.stringify(grant)) {
      if (value.requests > grant.max_requests || !audits || audits.filter(audit => audit?.authorization === extension.authorization && audit.from_max_requests === extension.from_max_requests && audit.to_max_requests === grant.max_requests).length !== 1) invalid();
      return row;
    }
    const previousGrant = { ...grant, max_requests: extension.from_max_requests };
    delete previousGrant.request_limit_extension;
    if (!validGrant(grant) || !validGrant(value.grant) || value.halted || value.halt_code || JSON.stringify(value.grant) !== JSON.stringify(previousGrant) || value.requests > previousGrant.max_requests || audits?.some(audit => audit?.authorization === extension.authorization)) invalid();
    const audit = { authorization: extension.authorization, from_max_requests: previousGrant.max_requests, to_max_requests: grant.max_requests, at: new Date().toISOString(), previous_budget_version: row.version, requests: value.requests, reserved_usd: value.reserved_usd };
    // One budget CAS also appends the store's durable event; competing reservations must win or fail,
    // never be overwritten by this explicit allowance change. The model switch is untouched.
    await store.put('budget', budgetId, row.version, { ...value, grant, request_limit_extensions: [...(audits || []), audit] });
    return store.get('budget', budgetId);
  }
  async function context() {
    if (!grantShape(grant)) return { session: null, row: null, budgetId: null };
    let session = manual ? await store.get('session', grant.id) : null;
    if (grant.request_limit_extension && (!manual || !session || session.value.budget_id !== grant.id)) throw new AppError('REQUEST_LIMIT_EXTENSION_INVALID', 'A request-limit extension requires the existing authorized session and allowance. No new session was created.', 503);
    if (manual && !session) {
      const parent = await store.get('budget', grant.id);
      const eligible = allowContinuation && validGrant(grant) && parent?.value.halted && parent.value.halt_code === 'AUTHORIZED_CASE_FINISHED' && JSON.stringify(parent.value.grant) === JSON.stringify(grant);
      const budgetId = eligible ? `${grant.id}--manual-continuation` : grant.id;
      const policy = { strategy: 'manual', enabled: false, budget_id: budgetId, authorization: carryForwardBudgetId ? 'practice policy' : 'manual multi-case policy', at: new Date().toISOString(), reason: 'manual_off', grant_id: grant.id };
      let child = null, parentGuard = null;
      if (eligible) {
        Object.assign(policy, { migrated_from: grant.id, parent_version: parent.version, inherited_requests: parent.value.requests, inherited_reserved_usd: parent.value.reserved_usd, original_expires_at: grant.expires_at });
        child = { id: budgetId, value: { requests: parent.value.requests, reserved_usd: parent.value.reserved_usd, grant: parent.value.grant, inherited_from: grant.id, inherited_parent_version: parent.version } };
        parentGuard = { id: grant.id, version: parent.version, mode: 'successful' };
      }
      if (carryForwardBudgetId) {
        const source = await store.get('budget', carryForwardBudgetId), value = source?.value;
        if (!value || value.halted || !grantShape(value.grant) || !Number.isSafeInteger(value.requests) || value.requests !== value.grant.max_requests || !Number.isFinite(value.reserved_usd) || value.reserved_usd < 0 || value.requests > grant.max_requests || value.reserved_usd > grant.max_usd) throw new AppError('PRACTICE_CARRY_INVALID', 'The prior practice count cannot be verified. Its history was not reset; a person must inspect it.', 503);
        Object.assign(policy, { migrated_from: carryForwardBudgetId, parent_version: source.version, inherited_requests: value.requests, inherited_reserved_usd: value.reserved_usd });
        child = { id: grant.id, value: { requests: value.requests, reserved_usd: value.reserved_usd, grant, inherited_from: carryForwardBudgetId, inherited_parent_version: source.version } };
        parentGuard = { id: carryForwardBudgetId, version: source.version, mode: 'exhausted' };
      }
      await store.initialiseModelSession(grant.id, policy, child, parentGuard);
      session = await store.get('session', grant.id);
    }
    const budgetId = session?.value.budget_id || grant.id;
    const row = await extendRequestLimit(session, budgetId, await store.get('budget', budgetId));
    return { session, budgetId, row };
  }
  function state(ctx) {
    const value = ctx.row?.value;
    const used = value?.requests || 0, reserved = value?.reserved_usd || 0;
    const unused = grantShape(grant) ? Math.max(0, grant.max_requests - used) : 0;
    let status;
    if (!grantShape(grant)) status = 'no_active_grant';
    else if (!validGrant(grant)) status = 'expired';
    else if (value && JSON.stringify(value.grant) !== JSON.stringify(grant)) status = 'unavailable';
    else if (value?.halted) status = value.halt_code === 'AUTHORIZED_CASE_FINISHED' || value.halt_code === 'APPROVED_CASE_COMPLETED' || value.halt_code === 'AUTHORIZED_CASE_GENERATION_FINISHED' ? 'closed' : 'faulted';
    else if (unused === 0 || reserved + requestReserveUsd > grant.max_usd) status = 'exhausted';
    else if (!configured) status = 'unavailable';
    else status = manual && !ctx.session?.value.enabled ? 'off' : 'ready';
    const canEnable = ['off', 'ready'].includes(status);
    return { enabled: status === 'ready', model_on: status === 'ready', manual_control: manual, can_enable: canEnable, control_version: ctx.session?.version ?? -1, status, stop_reason: reasons[status], remaining_requests: canEnable ? unused : 0, unused_requests: unused, requests_reserved: used, max_requests: grant?.max_requests || 0, conservative_reserved_usd: reserved, max_usd: grant?.max_usd || 0, expires_at: grant?.expires_at || null, continued_from_success: !!ctx.session?.value.migrated_from };
  }
  async function halt(code, sequence) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const ctx = await context();
      if (!ctx.row || ctx.row.value.halted) return;
      try { await store.put('budget', ctx.budgetId, ctx.row.version, { ...ctx.row.value, halted: true, halt_code: code, stopped_after_request: sequence }); return; }
      catch (error) { if (error.code !== 'STALE_CASE' || attempt === 6) throw error; }
    }
  }
  return { mode: provider.mode, model: provider.model, grantId: grant?.id || null, requiresAdmission: true,
    async availability() { return state(await context()); },
    async setEnabled(value) {
      if (!manual || !value || Object.keys(value).some(k => !['enabled', 'expected_version'].includes(k)) || typeof value.enabled !== 'boolean' || !Number.isInteger(value.expected_version)) throw new AppError('MODEL_CONTROL_INVALID', 'Supply the requested model state and current control version.', 400);
      const ctx = await context(), info = state(ctx);
      if (!ctx.session) throw new AppError('LIVE_BUDGET_REQUIRED', info.stop_reason, 409);
      if (ctx.session.version !== value.expected_version) throw new AppError('STALE_MODEL_CONTROL', 'The model switch changed. Refresh its saved state.', 409);
      if (value.enabled && !info.can_enable) throw new AppError('MODEL_SESSION_BLOCKED', info.stop_reason, 409);
      await store.put('session', grant.id, ctx.session.version, { ...ctx.session.value, enabled: value.enabled, at: new Date().toISOString(), reason: value.enabled ? 'manual_on' : 'manual_off' });
      return state(await context());
    },
    async completeCase(record) {
      if (!manual) return halt('AUTHORIZED_CASE_FINISHED', (await context()).row?.value.requests || 0);
      // An unusable provider result after output repairs is a terminal session fault.
      if (record?.error && !['MODEL_SESSION_OFF', 'LIVE_BUDGET_REQUIRED', 'LIVE_BUDGET_EXHAUSTED', 'LIVE_BATCH_STOPPED'].includes(record.error.code)) await halt(record.error.code, (await context()).row?.value.requests || 0);
    },
    async generate(request) {
      if (!validGrant(grant)) throw new AppError('LIVE_BUDGET_REQUIRED', reasons[grantShape(grant) ? 'expired' : 'no_active_grant'], 503);
      const bytes = new TextEncoder().encode(JSON.stringify({ instructions: request.instructions, contract: request.contract, input: request.input, context: request.context, triage: request.triage, sources: request.sources, feedback: request.feedback })).byteLength;
      if (bytes > maxInputBytes) throw new AppError('MODEL_INPUT_LIMIT', 'The request exceeds the approved 12,000-byte prompt limit. A person must reduce the context.', 422);
      let ctx, previous, info, next, admittedVersion;
      // Retry only a competing local/D1 reservation, never a provider request.
      for (let attempt = 0; attempt < 7; attempt++) {
        ctx = await context(); previous = ctx.row?.value || { requests: 0, reserved_usd: 0, grant };
        if (manual) {
          if (admittedVersion === undefined) admittedVersion = ctx.session?.version;
          else if (admittedVersion !== ctx.session?.version) throw new AppError('MODEL_SESSION_OFF', 'The model switch changed while accepting this request. Saved progress requires an explicit resume.', 409);
        }
        if (JSON.stringify(previous.grant) !== JSON.stringify(grant)) throw new AppError('LIVE_GRANT_CHANGED', 'An existing grant cannot be altered or reset.', 503);
        info = state(ctx);
        if (previous.halted) throw new AppError('LIVE_BATCH_STOPPED', info.stop_reason, 503);
        if (info.status === 'exhausted') throw new AppError('LIVE_BUDGET_EXHAUSTED', info.stop_reason, 503);
        if (manual && info.status === 'off') throw new AppError('MODEL_SESSION_OFF', 'Model is OFF. Saved progress is preserved; turn it on and explicitly resume to continue.', 409);
        if (!info.enabled) throw new AppError('MODEL_SESSION_UNAVAILABLE', info.stop_reason, 503);
        next = { ...previous, requests: previous.requests + 1, reserved_usd: Number((previous.reserved_usd + requestReserveUsd).toFixed(6)) };
        try {
          if (manual) await store.reserveModelRequest(grant.id, ctx.session.version, ctx.budgetId, ctx.row?.version ?? -1, next);
          else await store.put('budget', ctx.budgetId, ctx.row?.version ?? -1, next);
          break;
        } catch (error) { if (error.code !== 'STALE_CASE' || attempt === 6) throw error; }
      }
      // A later switch change blocks dispatch, even if OFF was followed quickly by ON.
      if (manual) {
        const latest = await store.get('session', grant.id);
        if (!latest?.value.enabled || latest.version !== ctx.session.version) throw new AppError('MODEL_SESSION_OFF', 'The model switch changed before dispatch. Its reservation remains recorded; saved progress can be resumed explicitly.', 409);
        const budget = await store.get('budget', ctx.budgetId);
        if (budget?.value.halted) throw new AppError('LIVE_BATCH_STOPPED', reasons.faulted, 503);
      }
      if (!validGrant(grant)) throw new AppError('LIVE_BUDGET_REQUIRED', reasons.expired, 503);
      request.onDispatch?.();
      try { return await provider.generate(request); }
      catch (error) { if (error?.code !== 'MODEL_OUTPUT_JSON') await halt(error?.code || 'PROVIDER_FAILED', next.requests); throw error; }
    }
  };
}
