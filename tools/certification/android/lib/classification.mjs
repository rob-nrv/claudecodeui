// Pure classification rules for the Android RuntimeNode certification
// harness. No filesystem or network access here — everything is plain data
// in, plain data out, so it can be unit-tested without a device.

export const STATUSES = ['VALIDATED', 'CONDITIONAL', 'FAILED', 'SKIPPED', 'UNKNOWN'];

// Worst-first. A single FAILED anywhere blocks overall VALIDATED; a single
// CONDITIONAL keeps the overall result at CONDITIONAL even if everything
// else passed — mirrors the HC-06 contract's "never round CONDITIONAL up".
const SEVERITY_ORDER = ['FAILED', 'CONDITIONAL', 'UNKNOWN', 'SKIPPED', 'VALIDATED'];

export function isKnownStatus(value) {
  return typeof value === 'string' && STATUSES.includes(value);
}

function assertKnownStatus(value, context) {
  if (!isKnownStatus(value)) {
    throw new Error(`${context}: unknown status ${JSON.stringify(value)}; must be one of ${STATUSES.join(', ')}`);
  }
}

/** The single worst status among a list, by the fixed severity order. Throws on empty input — there is no "worst of nothing". */
export function worstOf(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error('worstOf requires at least one status');
  }
  statuses.forEach((status, index) => assertKnownStatus(status, `worstOf[${index}]`));
  return statuses
    .slice()
    .sort((a, b) => SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b))[0];
}

/**
 * Creates an empty result store. `results` is keyed by test id; each entry
 * keeps a `history` of every observation so nothing is silently discarded —
 * only the `current` field is used for reporting.
 */
export function createResultStore() {
  return { results: {} };
}

function cloneEntry(id, name) {
  return { id, name, current: null, history: [] };
}

/**
 * Imports a prior, already-classified observation (e.g. the manual HC-06
 * run performed before this harness existed). Imported results are frozen:
 * a later import of the SAME test id is refused unless `supersede: true` is
 * passed explicitly, so a prior CONDITIONAL can never be quietly overwritten
 * by a rosier import.
 */
export function importResult(store, entry, options = {}) {
  const { id, name, status, notes = null, observedAt = null, evidenceRefs = [] } = entry;
  if (!id || !name) {
    throw new Error('importResult requires id and name');
  }
  assertKnownStatus(status, `importResult(${id})`);
  const existing = store.results[id];
  if (existing && existing.current && existing.current.source === 'manual-import' && !options.supersede) {
    throw new Error(`importResult(${id}): a prior manual import already exists; pass { supersede: true } to replace it deliberately`);
  }
  const record = { source: 'manual-import', status, notes, observedAt, evidenceRefs, recordedAt: new Date().toISOString() };
  const target = existing ?? cloneEntry(id, name);
  target.history.push(record);
  target.current = record;
  store.results[id] = target;
  return store;
}

/**
 * Records a fresh result the harness itself just observed. Always appended
 * to history and always becomes `current` — a harness run is allowed to
 * supersede an import (that's the point of re-running a test), but the
 * history keeps the prior classification for audit rather than erasing it.
 */
export function recordResult(store, entry) {
  const { id, name, status, notes = null, observedAt = null, evidenceRefs = [] } = entry;
  if (!id || !name) {
    throw new Error('recordResult requires id and name');
  }
  assertKnownStatus(status, `recordResult(${id})`);
  const record = { source: 'harness', status, notes, observedAt, evidenceRefs, recordedAt: new Date().toISOString() };
  const target = store.results[id] ?? cloneEntry(id, name);
  target.history.push(record);
  target.current = record;
  store.results[id] = target;
  return store;
}

/**
 * Overall certification status across every recorded test. Empty store (no
 * tests observed yet) reads UNKNOWN, never VALIDATED — there is no evidence
 * to validate against.
 */
export function overallStatus(store) {
  const ids = Object.keys(store.results);
  if (ids.length === 0) {
    return 'UNKNOWN';
  }
  return worstOf(ids.map((id) => store.results[id].current.status));
}

/** True only when every test id in `requiredIds` is present and VALIDATED. */
export function isFullyValidated(store, requiredIds) {
  return requiredIds.every((id) => store.results[id]?.current?.status === 'VALIDATED');
}

/** A flat, report-ready list of {id, name, status, source, notes}, sorted by id for stable output. */
export function summarize(store) {
  return Object.keys(store.results)
    .sort()
    .map((id) => {
      const entry = store.results[id];
      return {
        id,
        name: entry.name,
        status: entry.current.status,
        source: entry.current.source,
        notes: entry.current.notes,
        observedAt: entry.current.observedAt,
      };
    });
}
