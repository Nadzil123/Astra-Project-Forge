const COUNTERS = [
  'usefulCycles', 'avoidedCycles', 'reusedEvidence', 'duplicateToolCallsAvoided',
  'contextsCompacted', 'reasoningEscalations', 'softBudgetOverrides',
];

function requireInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be an object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} must contain only enumerable data properties`);
    }
  }
}

function normalizeEvent(event) {
  requireObject(event, 'Event');
  const stop = event.type === 'stop';
  if (!stop && !COUNTERS.includes(event.type)) throw new TypeError('Unknown efficiency event type');
  const fields = stop ? ['type', 'reason', 'provenance', 'revision'] : ['type', 'amount', 'provenance', 'revision'];
  if (Reflect.ownKeys(event).some(key => !fields.includes(key))) throw new TypeError('Unsupported efficiency event field or telemetry');
  requireObject(event.provenance, 'Event provenance');
  const { source, reference } = event.provenance;
  if (!['reported', 'store'].includes(source) || typeof reference !== 'string' || !reference.trim()
    || Reflect.ownKeys(event.provenance).some(key => !['source', 'reference'].includes(key))) {
    throw new TypeError('Event provenance requires a reported/store source and a reference');
  }
  if (Object.hasOwn(event, 'revision')) requireInteger(event.revision, 'Event revision');
  const next = { ...event, provenance: { source, reference } };
  if (stop) {
    if (typeof event.reason !== 'string' || !event.reason.trim()) throw new TypeError('Stop reason must be a non-empty string');
  } else {
    next.amount = requireInteger(Object.hasOwn(event, 'amount') ? event.amount : 1, 'Event amount');
  }
  return next;
}

export function emptyEfficiencyLedger() {
  return {
    usefulCycles: 0,
    avoidedCycles: 0,
    reusedEvidence: 0,
    duplicateToolCallsAvoided: 0,
    contextsCompacted: 0,
    reasoningEscalations: 0,
    softBudgetOverrides: 0,
    stopReason: null,
    events: [],
  };
}

export function normalizeEfficiencyLedger(ledger) {
  if (ledger == null) return emptyEfficiencyLedger();
  requireObject(ledger, 'Ledger');
  const next = { ...emptyEfficiencyLedger(), ...ledger };
  for (const counter of COUNTERS) requireInteger(next[counter], counter);
  if (next.stopReason !== null && (typeof next.stopReason !== 'string' || !next.stopReason.trim())) {
    throw new TypeError('Stop reason must be null or a non-empty string');
  }
  if (!Array.isArray(next.events)) throw new TypeError('Ledger events must be an array');
  next.events = next.events.map(normalizeEvent);
  return next;
}

export function applyEfficiencyEvent(ledger, event = {}) {
  const next = normalizeEfficiencyLedger(ledger);
  const validated = normalizeEvent(event);
  if (validated.type === 'stop') next.stopReason = validated.reason;
  else next[validated.type] = requireInteger(next[validated.type] + validated.amount, 'Counter sum');
  next.events.push(validated);
  return next;
}
