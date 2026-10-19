import { readModelEligibility, isEligibleModel } from './model-policy.mjs';

const capabilities = Object.freeze({
  catalogDiscovery: 'unknown',
  turnModelSelection: 'unsupported',
  effortControl: 'unsupported',
  trustedModelIdentity: 'unknown',
  subagentModelSelection: 'unknown',
  deferredToolLoading: 'unknown',
  usageTelemetry: 'unknown',
});

export function createAdvisoryHostAdapter(eligibility = readModelEligibility({})) {
  const policy = {
    requiredModel: eligibility.requiredModel,
    allowedModels: [...eligibility.allowedModels],
  };

  return {
    describe() {
      return {
        adapterId: 'manual-v1',
        mode: 'advisory',
        observedModel: null,
        eligibility: structuredClone(policy),
        capabilities: { ...capabilities },
      };
    },
    prepareHandoff(advice, capsule) {
      const requestedModel = advice?.recommendedModel;
      if (typeof requestedModel !== 'string' || !isEligibleModel(policy, requestedModel)) {
        throw new TypeError('Requested model is not eligible under operator policy');
      }
      return {
        status: 'user_action_required',
        requestedModel,
        capsule: structuredClone(capsule ?? null),
        persistedContextStatus: capsule == null ? 'unavailable' : 'available',
        switched: false,
        observedModel: null,
        executionStatus: 'not_attempted',
        availability: 'unknown',
        quota: 'unknown',
      };
    },
  };
}
