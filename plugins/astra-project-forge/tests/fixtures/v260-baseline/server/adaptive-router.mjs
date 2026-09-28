const enumValue = (value, allowed, fallback) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
};

const bool = value => value === true;
const uniqueStrings = value => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
};

export function routeTask(input = {}) {
  const complexity = enumValue(input.complexity, ['simple', 'moderate', 'complex'], 'moderate');
  const uncertainty = enumValue(input.uncertainty, ['low', 'medium', 'high'], 'medium');
  const continuityNeeded = bool(input.continuityNeeded);
  const repeatedFailure = bool(input.repeatedFailure);
  const crossDomain = bool(input.crossDomain);
  const verificationNeeded = input.verificationNeeded !== false;
  const multiStep = input.multiStep !== false;
  const capabilityNeeds = uniqueStrings(input.capabilityNeeds);
  const risk = enumValue(input.risk, ['low', 'medium', 'high'], 'low');
  const expectedIterations = Number.isInteger(input.expectedIterations) ? Math.max(0, input.expectedIterations) : 0;

  let score = { simple: 0, moderate: 2, complex: 4 }[complexity];
  score += { low: 0, medium: 1, high: 2 }[uncertainty];
  if (continuityNeeded) score += 2;
  if (repeatedFailure) score += 2;
  if (crossDomain) score += 1;
  if (verificationNeeded && complexity !== 'simple') score += 1;
  if (multiStep && complexity !== 'simple') score += 1;

  let profile;
  if (score <= 1) profile = 'off';
  else if (score <= 3) profile = 'light';
  else if (score <= 6) profile = 'standard';
  else profile = 'deep';

  const policy = {
    off: { cycleBudget: 0, stateDetail: 'none', projectMode: null, checkpoint: false },
    light: { cycleBudget: 1, stateDetail: 'summary', projectMode: 'standard', checkpoint: continuityNeeded },
    standard: { cycleBudget: 3, stateDetail: 'working', projectMode: 'standard', checkpoint: true },
    deep: { cycleBudget: 6, stateDetail: 'working', projectMode: 'deep', checkpoint: true },
  }[profile];

  let usageImpact = { off: 'MINIMAL', light: 'LOW', standard: 'MODERATE', deep: 'HIGH' }[profile];
  const elevatedUsage = profile === 'deep' && (risk === 'high' || expectedIterations >= 6 || capabilityNeeds.length >= 5);
  if (elevatedUsage) usageImpact = 'VERY HIGH';

  const reasons = [];
  if (complexity !== 'simple') reasons.push(`${complexity} complexity`);
  if (uncertainty !== 'low') reasons.push(`${uncertainty} uncertainty`);
  if (continuityNeeded) reasons.push('cross-turn or cross-session continuity');
  if (repeatedFailure) reasons.push('repeated failure requires strategy adaptation');
  if (crossDomain) reasons.push('cross-domain coordination');
  if (verificationNeeded && complexity !== 'simple') reasons.push('objective verification needed');
  if (multiStep && complexity !== 'simple') reasons.push('multi-step execution');
  if (elevatedUsage) reasons.push('usage impact raised by high risk, many capability calls, or many expected iterations');

  return {
    profile,
    score,
    complexity,
    uncertainty,
    cycleBudget: policy.cycleBudget,
    stateDetail: policy.stateDetail,
    contextDetail: policy.stateDetail,
    usageImpact,
    risk,
    expectedIterations,
    projectMode: policy.projectMode,
    checkpointRecommended: policy.checkpoint,
    capabilityNeeds,
    reasons,
    guidance: profile === 'off'
      ? 'Do not activate Astra Project Forge for this task unless new complexity or continuity appears.'
      : 'Use only the project context and specialized capabilities needed for the next decision. Prefer available installed capabilities when they match a capability need, and record only evidence or outcomes that matter to project continuity.',
  };
}
