function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Revision must be a non-negative safe integer');
  }
  return value;
}

export function selectDelta(items = [], sinceRevision = 0) {
  if (!Array.isArray(items)) throw new TypeError('Delta items must be an array');
  requireRevision(sinceRevision);
  const selected = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('Each delta item must be a record');
    }
    // Unstamped legacy records predate revision tracking; explicit bad stamps fail.
    const revision = Object.hasOwn(item, 'revision') ? requireRevision(item.revision) : 0;
    if (revision > sinceRevision) selected.push(item);
  }
  return selected;
}

export function compactContext(project = {}) {
  const experiments = new Map((project.experiments ?? []).map(item => [item.id, item]));
  const consolidation = project.consolidation;
  const verifiedLessons = (project.lessons ?? []).filter(lesson => {
    if (typeof lesson === 'string') return true;
    if (lesson.sourceExperimentId != null) {
      return experiments.get(lesson.sourceExperimentId)?.outcome === 'supported';
    }
    // The v2 store gives consolidation lessons no source ID. Only the retained,
    // evidence-backed consolidation can substantiate a matching lesson.
    return Boolean(consolidation?.verifiedResult && consolidation.evidence?.length
      && consolidation.lessons?.includes(lesson.text));
  });
  const archiveRef = {};
  for (const key of ['projectId', 'schemaVersion', 'revision']) {
    if (project[key] != null) archiveRef[key] = project[key];
  }
  return {
    stableFacts: (project.claims ?? []).filter(item => item.status === 'known'),
    activeGoals: (project.goalGraph ?? []).filter(item => ['active', 'pending', 'blocked'].includes(item.status)),
    unresolvedClaims: (project.claims ?? []).filter(item => ['unknown', 'contradicted', 'inferred'].includes(item.status)),
    verifiedLessons,
    recentEvaluations: (project.evaluations ?? []).slice(-5),
    recentChanges: {
      observations: (project.observations ?? []).slice(-5),
      experiments: (project.experiments ?? []).slice(-5),
      plans: (project.plans ?? []).slice(-5),
      adaptations: (project.adaptations ?? []).slice(-5),
    },
    latestCheckpoint: (project.checkpoints ?? []).at(-1) ?? null,
    consolidationRef: consolidation == null ? null : {
      createdAt: consolidation.createdAt,
      evidence: [...(consolidation.evidence ?? [])],
      remainingUncertainty: [...(consolidation.remainingUncertainty ?? [])],
    },
    archiveRef,
  };
}

export function progressiveResult(payload = {}, level = 'summary') {
  if (level === 'full') return payload.full ?? payload.relevant ?? payload.summary ?? null;
  if (level === 'relevant') return payload.relevant ?? payload.summary ?? null;
  return payload.summary ?? null;
}
