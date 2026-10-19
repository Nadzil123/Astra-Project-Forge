const DEFAULT_REQUIRED_MODEL = 'gpt-6.1-sol';
const normalize = value => String(value ?? '').trim().toLowerCase();

export function readModelEligibility(env) {
  const requiredModel = normalize(env.ASTRA_REQUIRED_MODEL) || DEFAULT_REQUIRED_MODEL;
  const allowedModels = [...new Set([
    requiredModel,
    ...String(env.ASTRA_ALLOWED_MODELS || '').split(',').map(normalize).filter(Boolean),
  ])];
  return { requiredModel, allowedModels };
}

export function isEligibleModel(policy, model) {
  const activeModel = normalize(model);
  return activeModel !== '' && activeModel !== 'unknown' && policy.allowedModels.includes(activeModel);
}

export function readRoutingMode(env) {
  const mode = env.ASTRA_FORGE_MODEL_ROUTING;
  if (mode === undefined || mode === 'off') return 'off';
  if (mode === 'advisory-v1') return mode;
  throw new TypeError('Invalid ASTRA_FORGE_MODEL_ROUTING: expected off or advisory-v1');
}
