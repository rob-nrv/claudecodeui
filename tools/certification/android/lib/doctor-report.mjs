// Pure helpers over an already-parsed `cloudcli node doctor --json` report
// (shape: server/modules/node-agent/node-agent-doctor.ts's NodeDoctorReport).
// No filesystem or process access — callers read the JSON file and pass the
// parsed object in, which keeps this testable against fixture reports.

const SCHEMA = 'cloudcli.node-doctor';

export function isDoctorReport(value) {
  return Boolean(value && typeof value === 'object' && value.schema === SCHEMA && value.version === 1);
}

function assertReport(report, context) {
  if (!isDoctorReport(report)) {
    throw new Error(`${context}: not a cloudcli.node-doctor v1 report`);
  }
}

export function capabilityStatus(report, capabilityId) {
  assertReport(report, 'capabilityStatus');
  return report.capabilities.find((entry) => entry.id === capabilityId)?.status ?? null;
}

export function isReadyForRuns(report) {
  assertReport(report, 'isReadyForRuns');
  return report.summary.readyForRuns === true;
}

export function blockers(report) {
  assertReport(report, 'blockers');
  return [...report.summary.blockers];
}

export function hasBlocker(report, blocker) {
  return blockers(report).includes(blocker);
}

/** Journal counts, normalized so a missing/unreadable journal reads as null rather than 0 (0 would claim health it can't back up). */
export function journalCounts(report) {
  assertReport(report, 'journalCounts');
  if (report.journal.state !== 'ok') {
    return { state: report.journal.state, unfinished: null, interrupted: null };
  }
  return { state: 'ok', unfinished: report.journal.unfinished, interrupted: report.journal.interrupted };
}

export function controlPlaneState(report) {
  assertReport(report, 'controlPlaneState');
  return report.controlPlane.state;
}

export function governorPolicy(report) {
  assertReport(report, 'governorPolicy');
  return { ...report.governor };
}

/**
 * Compares two evidence snapshots (e.g. before/after enrolling, before/after
 * signing in to Claude) and reports which capability ids changed status, so
 * a step's expected transition can be asserted precisely instead of eyeballed.
 */
export function diffCapabilities(before, after) {
  assertReport(before, 'diffCapabilities(before)');
  assertReport(after, 'diffCapabilities(after)');
  const beforeMap = new Map(before.capabilities.map((entry) => [entry.id, entry.status]));
  const afterMap = new Map(after.capabilities.map((entry) => [entry.id, entry.status]));
  const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changes = [];
  for (const id of ids) {
    const from = beforeMap.get(id) ?? null;
    const to = afterMap.get(id) ?? null;
    if (from !== to) {
      changes.push({ id, from, to });
    }
  }
  return changes;
}

/**
 * A report never carries secrets by construction (the doctor itself omits
 * them — see docs/android-runtime-node.md), but this is a second,
 * independent check before evidence is ever written to disk. Deliberately a
 * curated list of high-confidence secret-shaped key names, not a bare
 * substring like "credential" or "email" — the real report legitimately
 * carries `enrollment.credentialFile` (a permission *label*, "owner_only",
 * never file contents), and a bare match there would make this check cry
 * wolf on every real report and get ignored.
 */
const FORBIDDEN_KEY_PATTERN = /privateKey|publicKey|credentialJson|enrollmentCode|token|password|secret|apiKey|accountEmail|organizationId|authorization/i;

export function containsForbiddenField(value, path = []) {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsForbiddenField(value[index], [...path, index]);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      return [...path, key].join('.');
    }
    const found = containsForbiddenField(value[key], [...path, key]);
    if (found) return found;
  }
  return null;
}
