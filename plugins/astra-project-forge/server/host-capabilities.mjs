// Advice only: this catalog never changes MCP discovery or host permissions.
export const STABLE_CATALOG = Object.freeze([
  'forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan', 'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate',
  'adaptive_route_task', 'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
  'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment', 'adaptive_checkpoint', 'adaptive_consolidate',
]);
const stages = {
  route: ['forge_route', 'forge_goal', 'forge_plan'],
  plan: ['forge_goal', 'forge_plan', 'forge_observe'],
  observe: ['forge_observe', 'forge_evaluate', 'forge_adapt'],
  evaluate: ['forge_evaluate', 'forge_observe', 'forge_adapt', 'forge_consolidate'],
  context: ['forge_goal', 'forge_context'],
  recovery: ['forge_context', 'forge_adapt', 'forge_plan', 'adaptive_list_projects'],
};
const recovery = ['forge_context', 'forge_checkpoint', 'adaptive_get_state'];

export function validateHostCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hostCapabilities must be an object');
  for (const key of Object.keys(value)) {
    if (!['deferredDiscovery', 'allowedSubset', 'discoveryAvailable'].includes(key) || typeof value[key] !== 'boolean') {
      throw new TypeError('Invalid hostCapabilities: only deferredDiscovery, allowedSubset and discoveryAvailable booleans are supported');
    }
  }
}

export function selectCapabilities({ stage, hostCapabilities } = {}) {
  if (hostCapabilities !== undefined) validateHostCapabilities(hostCapabilities);
  let mode = 'stable_catalog', reason = 'Host support is unknown or unsupported';
  if (!Object.hasOwn(stages, stage)) reason = 'Unsupported stage; use the stable catalog';
  else if (hostCapabilities?.discoveryAvailable === false) reason = 'Discovery unavailable or failed; use the stable catalog';
  else if (hostCapabilities?.deferredDiscovery === true && hostCapabilities.discoveryAvailable === true) {
    mode = 'deferred_discovery'; reason = 'Caller reports deferred discovery support; host adapter may test this suggestion';
  } else if (hostCapabilities?.allowedSubset === true) {
    mode = 'allowed_subset'; reason = 'Caller reports reversible subset support; host adapter may test this suggestion';
  }
  const candidates = mode === 'stable_catalog' ? STABLE_CATALOG : [...stages[stage], ...recovery];
  return { advisory: true, mode, selected: STABLE_CATALOG.filter(name => candidates.includes(name)),
    fallback: [...STABLE_CATALOG], reason, permissionsChanged: false, cacheSavings: null };
}
