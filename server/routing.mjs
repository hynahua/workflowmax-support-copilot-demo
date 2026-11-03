export function riskFloor(input) {
  const text = `${input.subject} ${input.body}`.toLowerCase();
  const rules = [
    ['bug', /http\s*500|repeated (?:save |saving )?error|returns? (?:an? )?error|entries disappear|\bcrash(?:es|ing)?\b|\bnot working\b/],
    ['complaint', /\bunhappy\b|unacceptable|frustrat|\bcomplain/],
    ['churn', /cancel(?:ling|ing)? (?:our |my |the )?subscription|considering cancell|\bleav(?:e|ing) (?:the )?(?:platform|service)/],
    ['financial_advice', /tax treatment|tax decision|tax advice|which tax/],
    ['access', /\bpermission\b|access issue|not allowed to/],
    ['locked_record', /submitted.{0,35}(?:timesheet|locked)|timesheet.{0,35}(?:submitted|locked)|bypass (?:the )?lock|\bunlock/],
    ['instruction_attack', /(?:ignore|disregard).{0,35}(?:instructions|rules)|reveal.{0,35}(?:api|system prompt)|invent an article|fabricate.{0,20}(?:citation|article)/]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
}

export function intentLabels(input, flags) {
  const text = `${input.subject} ${input.body}`.toLowerCase();
  const labels = [];
  if (/how|where|steps|point me|does|setting|enter|create/.test(text)) labels.push('how_to');
  if (flags.includes('bug')) labels.push('bug_report');
  if (flags.includes('complaint')) labels.push('complaint');
  if (flags.includes('churn')) labels.push('churn_signal');
  if (flags.includes('access') || flags.includes('locked_record')) labels.push('permission_question');
  return labels.length ? labels : ['unknown'];
}

export function acknowledgement(route) {
  return route === 'escalate'
    ? 'Thank you for flagging this. A support team member needs to review your request and the relevant context before providing further guidance. The cause and any account changes have not been verified.'
    : 'Thank you for your question. The selected help articles do not provide enough evidence for a reliable answer. A support team member can clarify the request or consult an approved additional source.';
}

export function enforceRouting(analysis, floor, sources) {
  const risk_flags = [...new Set([...floor, ...analysis.risk_flags])];
  const mapped = { bug: 'bug_report', complaint: 'complaint', churn: 'churn_signal', access: 'permission_question', locked_record: 'permission_question' };
  const intents = [...new Set([...analysis.intents, ...risk_flags.map(flag => mapped[flag]).filter(Boolean)])];
  const significant = risk_flags.filter(flag => flag !== 'uncertain');
  let route = analysis.route;
  let reason = analysis.reason;
  if (significant.length) {
    route = 'escalate';
    reason = `Human handling required: ${significant.join(', ')}. Any retrieved guidance is context, not a verified fix or authorization.`;
  } else if (!sources.length || risk_flags.includes('uncertain')) {
    route = 'clarify';
    reason = !sources.length ? 'No sufficiently relevant active source exists in this small demo collection. This does not establish whether the product supports the feature.' : 'The request remains uncertain and needs human clarification.';
  }
  return { ...analysis, risk_flags, intents, route, reason, draft: route === 'draft' ? analysis.draft : acknowledgement(route) };
}
