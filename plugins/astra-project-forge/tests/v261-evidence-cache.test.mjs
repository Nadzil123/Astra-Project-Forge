import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintDependencies, makeEvidenceKey, freshnessFor,
  canReuseEvidence, invalidateByChangedDependency,
} from '../server/evidence-cache.mjs';

test('dependency order and duplicates do not change the fingerprint', () => {
  assert.equal(fingerprintDependencies(['b@2', 'a@1', 'a@1']), fingerprintDependencies(['a@1', 'b@2']));
  assert.equal(fingerprintDependencies(), fingerprintDependencies([]));
  assert.match(fingerprintDependencies([]), /^[a-f0-9]{64}$/);
});

test('dependency changes and structured boundaries produce distinct fingerprints', () => {
  const inputs = [[], ['a@1'], ['a@2'], ['a', 'b'], ['a,b'], ['a@1', 'b@2']];
  assert.equal(new Set(inputs.map(fingerprintDependencies)).size, inputs.length);
});

test('invalid dependencies fail clearly instead of coercing values', () => {
  for (const dependencies of [null, 'a', {}, [1], [null], [''], ['  '], [undefined], [Symbol('a')], [[]], Array(1)]) {
    assert.throws(() => fingerprintDependencies(dependencies), TypeError);
    assert.throws(() => makeEvidenceKey({ dependencies }), TypeError);
    assert.throws(() => freshnessFor({ freshness: 'fresh' }, dependencies), TypeError);
    assert.throws(() => canReuseEvidence(null, { dependencies }), TypeError);
  }
});

test('keys canonicalize nested object order including objects within arrays', () => {
  assert.match(makeEvidenceKey(), /^[a-f0-9]{64}$/);
  assert.equal(
    makeEvidenceKey({ kind: 'test', target: 'router', params: { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } }, dependencies: ['b', 'a'] }),
    makeEvidenceKey({ target: 'router', kind: 'test', params: { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }] }, dependencies: ['a', 'b', 'a'] }),
  );
  assert.equal(makeEvidenceKey(), makeEvidenceKey({ kind: '', target: '', params: null, dependencies: [] }));
});

test('keys distinguish array order, JSON types, and structural boundaries', () => {
  const params = [null, false, true, 0, '0', '', [], {}, [1, 2], [2, 1], ['a,b'], ['a', 'b'], { a: 1 }, { a: '1' }];
  assert.equal(new Set(params.map(value => makeEvidenceKey({ params: value }))).size, params.length);
});

test('kind, target, params, and dependencies each contribute to the key', () => {
  const base = { kind: 'test', target: 'router', params: { a: 1 }, dependencies: ['a@1'] };
  for (const patch of [{ kind: 'read' }, { target: 'config' }, { params: { a: 2 } }, { dependencies: ['a@2'] }]) {
    assert.notEqual(makeEvidenceKey(base), makeEvidenceKey({ ...base, ...patch }));
  }
  assert.notEqual(makeEvidenceKey({ kind: 'a,b', target: 'c' }), makeEvidenceKey({ kind: 'a', target: 'b,c' }));
});

test('non-JSON params fail clearly at every depth', () => {
  for (const params of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('p'), () => {}, new Date(), new Map(), new Set(), /a/]) {
    for (const value of [params, { nested: params }, [params]]) {
      assert.throws(() => makeEvidenceKey({ params: value }), TypeError);
    }
  }
});

test('cycles are rejected but shared non-cyclic objects are valid', () => {
  const object = {}; object.self = object;
  const array = []; array.push(array);
  for (const params of [object, array]) assert.throws(() => makeEvidenceKey({ params }), /cycl/i);
  const shared = { x: 1 };
  assert.equal(makeEvidenceKey({ params: [shared, shared] }), makeEvidenceKey({ params: [{ x: 1 }, { x: 1 }] }));
});

test('JSON serialization cannot silently drop properties or execute accessors', () => {
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { assert.fail('getter executed'); } });
  const hidden = Object.defineProperty({}, 'x', { value: 1 });
  for (const params of [Array(1), Object.assign([], { extra: 1 }), { [Symbol('x')]: 1 }, accessor, hidden, { toJSON() { return {}; } }]) {
    assert.throws(() => makeEvidenceKey({ params }), TypeError);
  }
});

test('special object keys are retained without prototype collisions', () => {
  const params = JSON.parse('{"__proto__":{"x":1},"constructor":2}');
  assert.notEqual(makeEvidenceKey({ params }), makeEvidenceKey({ params: { constructor: 2 } }));
  assert.equal(makeEvidenceKey({ params }), makeEvidenceKey({ params: Object.assign(Object.create(null), params) }));
});

test('invalid key envelopes and non-string identity fields fail clearly', () => {
  for (const input of [null, [], 1, 'test']) assert.throws(() => makeEvidenceKey(input), TypeError);
  for (const field of ['kind', 'target']) {
    for (const value of [null, 1, {}, false]) assert.throws(() => makeEvidenceKey({ [field]: value }), TypeError);
  }
});

for (const [state, low, high] of [['fresh', true, true], ['probably_fresh', true, false], ['stale', false, false], ['invalidated', false, false]]) {
  test(`${state} preserves its freshness with matching dependencies and respects risk`, () => {
    const record = { freshness: state, dependencyFingerprint: fingerprintDependencies(['a@1']) };
    assert.equal(freshnessFor(record, ['a@1']), state);
    assert.equal(canReuseEvidence(record, { dependencies: ['a@1'], risk: 'low' }), low);
    assert.equal(canReuseEvidence(record, { dependencies: ['a@1'], risk: 'high' }), high);
  });
}

test('changed dependencies make reusable evidence stale', () => {
  for (const freshness of ['fresh', 'probably_fresh', 'stale', 'invalidated']) {
    const record = { freshness, dependencyFingerprint: fingerprintDependencies(['a@1']) };
    for (const dependencies of [[], ['a@2'], ['a@1', 'b@1']]) {
      assert.equal(freshnessFor(record, dependencies), freshness === 'invalidated' ? 'invalidated' : 'stale');
      assert.equal(canReuseEvidence(record, { dependencies }), false);
    }
  }
});

test('absent and malformed records cannot be reused', () => {
  assert.equal(canReuseEvidence(), false);
  for (const record of [undefined, null, {}, [], false, 'fresh', 1]) {
    assert.equal(freshnessFor(record, []), 'stale');
    assert.equal(canReuseEvidence(record, { dependencies: [] }), false);
  }
});

test('unknown dependency state cannot be mistaken for an empty verified set', () => {
  for (const record of [{ freshness: 'fresh' }, { freshness: 'probably_fresh' }, { freshness: 'fresh', dependencyFingerprint: '' }]) {
    assert.equal(freshnessFor(record, []), 'stale');
    assert.equal(canReuseEvidence(record, { dependencies: [] }), false);
  }
  const record = { freshness: 'fresh', dependencyFingerprint: fingerprintDependencies([]) };
  assert.equal(freshnessFor(record), 'stale');
  assert.equal(canReuseEvidence(record), false);
  assert.equal(canReuseEvidence(record, { dependencies: [] }), true);
});

test('unknown freshness cannot certify reuse even with matching dependencies', () => {
  for (const freshness of [undefined, null, 'unknown', 'constructor']) {
    const record = { freshness, dependencyFingerprint: fingerprintDependencies([]) };
    assert.equal(freshnessFor(record, []), 'stale');
    assert.equal(canReuseEvidence(record, { dependencies: [] }), false);
  }
});

test('explicit stale and invalidated records stay non-reusable without dependency knowledge', () => {
  for (const freshness of ['stale', 'invalidated']) {
    assert.equal(freshnessFor({ freshness }), freshness);
    assert.equal(canReuseEvidence({ freshness }), false);
  }
});

test('invalidation is selective, exact, and preserves metadata and invalidated state', () => {
  const records = [
    { evidenceId: 'a', freshness: 'fresh', dependencyIds: ['src/a'], dependencyFingerprint: 'old', metadata: { source: 'test' } },
    { evidenceId: 'b', freshness: 'probably_fresh', dependencyIds: ['src/ab'] },
    { evidenceId: 'c', freshness: 'invalidated', dependencyIds: ['src/a'] },
    { evidenceId: 'd', freshness: 'fresh' },
    { evidenceId: 'e', freshness: 'stale', dependencyIds: [] },
  ];
  const before = structuredClone(records);
  const result = invalidateByChangedDependency(records, ['src/a', 'src/a']);
  assert.deepEqual(result, [ { ...before[0], freshness: 'stale' }, ...before.slice(1) ]);
  assert.deepEqual(records, before);
  assert.deepEqual(invalidateByChangedDependency(result, ['src/a']), result);
  assert.deepEqual(invalidateByChangedDependency(records, []), before);
  assert.deepEqual(invalidateByChangedDependency(), []);
});

test('invalidation rejects malformed IDs and record collections', () => {
  for (const changed of [null, 'a', [1], [''], Array(1)]) {
    assert.throws(() => invalidateByChangedDependency([], changed), TypeError);
  }
  for (const records of [null, {}, [null], [1], [{ dependencyIds: [1] }], [{ dependencyIds: null }], Array(1)]) {
    assert.throws(() => invalidateByChangedDependency(records, []), TypeError);
  }
});

test('all helpers accept frozen inputs without mutations and give deterministic results', () => {
  const dependencies = Object.freeze(['b@2', 'a@1']);
  const params = Object.freeze({ z: Object.freeze([2, 1]), a: Object.freeze({ n: 3 }) });
  const input = Object.freeze({ kind: 'test', target: 'router', params, dependencies });
  const record = Object.freeze({ freshness: 'fresh', dependencyFingerprint: fingerprintDependencies(dependencies), dependencyIds: dependencies, metadata: params });
  const records = Object.freeze([record]);
  assert.equal(makeEvidenceKey(input), makeEvidenceKey(input));
  assert.equal(freshnessFor(record, dependencies), 'fresh');
  assert.equal(canReuseEvidence(record, input), true);
  assert.equal(invalidateByChangedDependency(records, Object.freeze(['a@1']))[0].freshness, 'stale');
  assert.equal(record.freshness, 'fresh');
  assert.deepEqual(dependencies, ['b@2', 'a@1']);
});
