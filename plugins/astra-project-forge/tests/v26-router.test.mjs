import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../server/adaptive-router.mjs';

const rank = { MINIMAL: 0, LOW: 1, MODERATE: 2, HIGH: 3, 'VERY HIGH': 4 };

test('returns usage impact and context detail for every routing profile', () => {
  const off = routeTask({ complexity: 'simple', uncertainty: 'low', verificationNeeded: false, multiStep: false });
  const light = routeTask({ complexity: 'moderate', uncertainty: 'low', verificationNeeded: false, multiStep: false });
  const standard = routeTask({ complexity: 'moderate', uncertainty: 'medium', continuityNeeded: false, verificationNeeded: false, multiStep: true });
  const deep = routeTask({ complexity: 'complex', uncertainty: 'high', continuityNeeded: true, repeatedFailure: true, crossDomain: true, capabilityNeeds: ['repository', 'testing', 'review'] });

  assert.equal(off.profile, 'off');
  assert.equal(off.usageImpact, 'MINIMAL');
  assert.equal(off.contextDetail, 'none');
  assert.equal(light.profile, 'light');
  assert.equal(light.contextDetail, 'summary');
  assert.equal(standard.profile, 'standard');
  assert.equal(standard.contextDetail, 'working');
  assert.equal(deep.profile, 'deep');
  assert.equal(deep.contextDetail, 'working');
  assert.ok(rank[off.usageImpact] <= rank[light.usageImpact]);
  assert.ok(rank[light.usageImpact] <= rank[standard.usageImpact]);
  assert.ok(rank[standard.usageImpact] <= rank[deep.usageImpact]);
});

test('can raise deep work to VERY HIGH usage impact without changing the workflow profile', () => {
  const route = routeTask({
    complexity: 'complex', uncertainty: 'high', continuityNeeded: true, repeatedFailure: true,
    crossDomain: true, risk: 'high', expectedIterations: 8,
    capabilityNeeds: ['repository', 'testing', 'review', 'security', 'ci']
  });
  assert.equal(route.profile, 'deep');
  assert.equal(route.usageImpact, 'VERY HIGH');
  assert.ok(route.reasons.some(reason => /usage/i.test(reason)));
});
