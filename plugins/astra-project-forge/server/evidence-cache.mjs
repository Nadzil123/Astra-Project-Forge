import { createHash } from 'node:crypto';

const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function dependencySet(values) {
  if (!Array.isArray(values)) throw new TypeError('Dependencies must be an array of non-empty strings');
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError('Dependency IDs must be non-empty strings');
    }
  }
  return [...new Set(values)].sort();
}

function canonicalParams(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const array = Array.isArray(value);
  if (!array && !isRecord(value)) throw new TypeError('Params must contain only JSON values');
  if (ancestors.has(value)) throw new TypeError('Params must not contain cycles');
  ancestors.add(value);

  // Inspect descriptors so JSON conversion cannot invoke getters or silently
  // discard symbols, hidden fields, sparse elements, or array properties.
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
    throw new TypeError('Params arrays must contain only dense JSON elements');
  }
  const result = array ? [] : Object.create(null);
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Params must contain only enumerable JSON data properties');
    }
    result[key] = canonicalParams(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return result;
}

export function fingerprintDependencies(values = []) {
  return hash(dependencySet(values));
}

export function makeEvidenceKey(input = {}) {
  if (!isRecord(input)) throw new TypeError('Evidence key input must be an object');
  const { kind = '', target = '', dependencies = [] } = input;
  if (typeof kind !== 'string' || typeof target !== 'string') {
    throw new TypeError('Evidence kind and target must be strings');
  }
  return hash({
    kind,
    target,
    params: canonicalParams(Object.hasOwn(input, 'params') ? input.params : null),
    dependencies: dependencySet(dependencies),
  });
}

export function freshnessFor(record, dependencies) {
  const fingerprint = dependencies === undefined ? undefined : fingerprintDependencies(dependencies);
  if (!isRecord(record)) return 'stale';
  if (record.freshness === 'invalidated') return 'invalidated';
  if (record.freshness === 'stale') return 'stale';
  // Omitted dependencies are unknown, not a verified empty dependency set.
  if (fingerprint === undefined || record.dependencyFingerprint !== fingerprint) return 'stale';
  return ['fresh', 'probably_fresh'].includes(record.freshness) ? record.freshness : 'stale';
}

export function canReuseEvidence(record, input = {}) {
  if (!isRecord(input)) return false;
  const freshness = freshnessFor(record, input.dependencies);
  return freshness === 'fresh' || (freshness === 'probably_fresh' && input.risk !== 'high');
}

export function invalidateByChangedDependency(records = [], changedIds = []) {
  if (!Array.isArray(records)) throw new TypeError('Evidence records must be an array');
  const changed = new Set(dependencySet(changedIds));
  const result = [];
  for (const record of records) {
    if (!isRecord(record)) throw new TypeError('Each evidence record must be an object');
    const ids = Object.hasOwn(record, 'dependencyIds') ? dependencySet(record.dependencyIds) : [];
    result.push(record.freshness !== 'invalidated' && ids.some(id => changed.has(id))
      ? { ...record, freshness: 'stale' }
      : { ...record });
  }
  return result;
}
