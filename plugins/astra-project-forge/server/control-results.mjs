// Response-only omissions: all unlisted fields, wrapper keys and nulls survive.
// In particular, route guidance/reasons remain intact for off, completion and
// justification decisions. stateDetail and softCycleBudget retain the aliases'
// values. Persisted routes/records and cache retrieval results are never pruned.
const omissions = {
  forge_route: {
    route: ['score', 'complexity', 'uncertainty', 'expectedIterations', 'contextDetail', 'cycleBudget'],
  },
  forge_plan: {
    plan: ['action', 'why', 'expectedEvidence', 'createdAt'],
  },
  forge_observe: {
    observation: ['observation', 'evidence', 'createdAt'],
    claim: ['createdAt', 'updatedAt'],
    transferCandidate: ['createdAt', 'updatedAt', 'relevance'],
    // Registration acknowledges the caller's result. Route/plan retrieval must
    // still deliver that full result, including any verification details.
    evidenceRecord: ['result'],
  },
  forge_evaluate: {
    evaluation: ['createdAt'],
  },
};

export function projectControlResult(name, result, resultLevel) {
  if (resultLevel !== 'summary' || result.isError || !Object.hasOwn(omissions, name)) return result;
  const structuredContent = { ...result.structuredContent };
  for (const [key, fields] of Object.entries(omissions[name])) {
    if (!Object.hasOwn(structuredContent, key) || structuredContent[key] === null) continue;
    const record = { ...structuredContent[key] };
    for (const field of fields) if (record[field] !== null) delete record[field];
    structuredContent[key] = record;
  }
  return { ...result, structuredContent };
}
