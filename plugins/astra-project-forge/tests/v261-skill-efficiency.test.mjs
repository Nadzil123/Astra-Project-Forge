import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../skills/astra-project-forge/SKILL.md', import.meta.url), 'utf8');
const text = skill.replace(/\*\*|`/g, '').replace(/\s+/g, ' ');
const completionSentence = skill.split('## Stop conditions\n')[1].trim().split('\n\n')[0];
const completionPattern = /^When success criteria are satisfied, evidence is sufficient, no important contradiction remains, and no meaningful unresolved risk remains, stop immediately even if workflow budget remains\.$/i;

test('efficiency defaults to balanced and gates expensive work on decision value', () => {
  assert.match(text, /Efficiency First.*Default to the balanced efficiency policy/i);
  assert.match(text, /Before.*expensive work.*(?:decision|criterion).*uncertainty.*evidence.*risk.*progress/i);
  assert.match(text, /Useful computation is not waste/i);
});

test('soft budget exhaustion permits justified useful work without lowering quality', () => {
  assert.match(text, /soft budget.*(?:guide|guidance).*not.*hard stop/i);
  assert.match(text, /justify-before-spend.*record.*before.*expensive.*(?:continue|proceed)/i);
  assert.match(text, /(?:preserve|maintain).*quality.*escalate.*success criteria/i);
  assert.doesNotMatch(text, /workflow budget limits adaptive cycles/i);
});

test('over-budget plans provide a concrete categorized override before execution', () => {
  assert.match(text, /forge_plan.*budgetOverride.*category.*justification/i);
  assert.match(text, /unmet_success_criterion.*(?:package|verification)/i);
  assert.match(text, /(?:no|without).*extra.*governor call/i);
});

test('cheap plan defaults cannot be used to evade the expensive-work guard', () => {
  assert.match(text, /MODERATE.*HIGH.*VERY HIGH.*(?:expensive|guard)/i);
  assert.match(text, /(?:default LOW|LOW default).*caller-reported.*cheap probe/i);
  assert.match(text, /classify.*honestly.*(?:never|do not).*(?:understate|evade)/i);
});

test('fresh evidence reuse is dependency-aware and preserves risk floors', () => {
  assert.match(text, /fresh.*unchanged.*(?:reuse|skip)|reuse.*fresh.*unchanged/i);
  assert.match(text, /probably_fresh.*risk.*refresh/i);
  assert.match(text, /stale.*decision-relevant.*invalidated.*revalidat/i);
  assert.match(text, /evidenceRecord.*dependencies.*dependencyIds/i);
  assert.match(text, /cacheRequest.*invalidate_evidence.*changedDependencyIds/i);
});

test('marginal value stops redundant verification and scales remaining checks to risk', () => {
  assert.match(text, /marginal value.*stop repeated verification.*unlikely to change.*decision/i);
  assert.match(text, /(?:scale|weight).*verification.*(?:consequence|risk).*uncertainty/i);
  assert.match(text, /(?:skip|avoid).*duplicate tool calls/i);
});

test('cheap diagnostics narrow the problem before deeper investigation', () => {
  assert.match(text, /cheap-probe-first.*diagnostic.*narrow.*(?:enough|sufficient).*deeper/i);
});

test('anti-thrashing records failure and conditions retries on changed evidence or conditions', () => {
  assert.match(text, /anti-thrashing.*record.*failed.*cause.*retry/i);
  assert.match(text, /(?:do not|never) repeat.*unchanged.*(?:new evidence|changed conditions)/i);
});

test('escalation hysteresis holds effort while the triggering uncertainty persists', () => {
  assert.match(text, /hysteresis.*(?:hold|keep|remain).*until.*uncertainty.*resolved.*risk.*(?:decreases|reduced).*success.*verified/i);
});

test('de-escalation hysteresis rejects immediate escalation over minor uncertainty', () => {
  assert.match(text, /After de-escalation.*minor uncertainty.*(?:must not|does not).*immediate re-escalation/i);
});

test('action coalescing excludes dependencies, differing permissions, ordering and added risk', () => {
  assert.match(text, /(?:coalesc|batch).*independent.*(?:reduce|save).*round trips/i);
  assert.match(text, /(?:keep|execute).*sequential.*result.*determines.*permissions differ.*ordering.*risk/i);
});

test('parallelism requires independent value beyond availability', () => {
  assert.match(text, /Parallel.*independent.*latency.*independent verification.*different strategies/i);
  assert.match(text, /(?:do not|never).*duplicate.*workers.*available/i);
});

test('selective context uses progressive and delta retrieval with valid full recovery options', () => {
  assert.match(text, /resultLevel.*summary.*relevant.*full.*decision/i);
  assert.match(text, /sinceRevision.*delta/i);
  assert.match(text, /(?:omit|exclude).*sinceRevision.*full.*recovery/i);
  assert.match(text, /(?:compact|compaction).*facts.*goals.*(?:uncertainties|uncertainty).*archive.*references/i);
  assert.match(text, /(?:skip|avoid).*irrelevant context reloads/i);
});

test('cache-aware layout retains stable prefixes and appends dynamic state', () => {
  assert.match(text, /stable.*(?:instructions|context).*prefix.*dynamic state.*(?:later|after)/i);
});

test('host controls and efficiency events are reported honestly without invented measurements', () => {
  assert.match(text, /reasoning controls.*only.*exposed and permitted.*(?:never|do not).*pretend/i);
  assert.match(text, /Do not fabricate token counts, compute usage, cache hits, billing, or savings/i);
  assert.match(text, /record_efficiency_event.*provenance.*source.*reported.*reference/i);
  assert.match(text, /context reads.*(?:do not|never).*counter events/i);
  assert.match(text, /set_efficiency_policy.*efficiencyPolicy/i);
});

test('completion requires sufficient evidence with no important contradiction or meaningful risk', () => {
  assert.match(completionSentence, completionPattern);
});

test('completion assertion rejects disjunction between its required conditions', () => {
  const disjunction = 'When success criteria are satisfied OR evidence is sufficient OR no important contradiction remains OR no meaningful unresolved risk remains, stop immediately even if workflow budget remains.';
  assert.doesNotMatch(disjunction, completionPattern);
});
