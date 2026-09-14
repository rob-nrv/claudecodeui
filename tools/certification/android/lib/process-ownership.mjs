// Pure "did we actually start this process, and is it safe to signal it"
// logic. Takes already-collected ps/pgrep-style facts (as plain strings and
// numbers) and decides — it never shells out itself, so the actual
// decision rules are testable without a device, a real process, or root.

/**
 * A record of a process the runner itself started or is about to touch.
 * `startTime` (when available — e.g. `ps -o lstart=` or `/proc/<pid>/stat`'s
 * field 22) guards against PID reuse: the OS can hand the same pid to an
 * unrelated process later, and a bare pid match would then risk signalling
 * a stranger's process. When a caller cannot obtain a start time (some
 * minimal Android/Termux ps builds don't expose one), pass `null` and
 * ownership review falls back to the command-line check alone, explicitly
 * marked lower-confidence rather than silently treated as equal.
 */
export function recordOwnedProcess({ pid, role, commandSubstring, cmdlineAtCapture, startTime = null, startedAt = null }) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`recordOwnedProcess: refusing to own an invalid pid (${pid}); pid 1 and below are never a test process`);
  }
  if (!role || !commandSubstring || !cmdlineAtCapture) {
    throw new Error('recordOwnedProcess requires role, commandSubstring and cmdlineAtCapture');
  }
  if (!cmdlineAtCapture.includes(commandSubstring)) {
    throw new Error(`recordOwnedProcess(${role}): the captured cmdline does not even contain "${commandSubstring}" — this is not the process it claims to be`);
  }
  return { pid, role, commandSubstring, cmdlineAtCapture, startTime, startedAt: startedAt ?? new Date().toISOString() };
}

/**
 * Re-checks a previously recorded process against a fresh ps lookup.
 * `current` is `null` when the pid no longer exists (already exited).
 */
export function verifyStillOwned(record, current) {
  if (current === null) {
    return { owned: false, confidence: 'none', reason: 'process no longer exists' };
  }
  if (current.pid !== record.pid) {
    throw new Error('verifyStillOwned: current.pid does not match the record — pass the lookup for the same pid');
  }
  if (!current.cmdline || !current.cmdline.includes(record.commandSubstring)) {
    return { owned: false, confidence: 'none', reason: `current cmdline does not contain "${record.commandSubstring}" — likely a different process now holds this pid` };
  }
  if (record.startTime !== null && current.startTime !== null) {
    if (record.startTime !== current.startTime) {
      return { owned: false, confidence: 'none', reason: 'start time changed — the pid was reused by an unrelated process' };
    }
    return { owned: true, confidence: 'high', reason: 'cmdline and start time both match' };
  }
  return { owned: true, confidence: 'low', reason: 'cmdline matches, but no start time was available to rule out pid reuse' };
}

/**
 * Only a `kill -<signal> <single positive integer pid>` (or `kill <pid>`,
 * default signal) is ever accepted as a "safe kill" shape. Anything naming
 * a process by pattern (`pkill`, `killall`, `kill -9 $(pgrep ...)`, a
 * negative pid meaning "process group", multiple pids) is refused outright
 * — the harness must always know the exact single process it is signalling.
 */
export function isSafeKillCommand(command) {
  const trimmed = String(command ?? '').trim();
  const match = /^kill(?:\s+-\d+)?\s+(\d+)$/.exec(trimmed);
  if (!match) {
    return { safe: false, reason: 'not a plain "kill [-signal] <single pid>" command' };
  }
  const pid = Number(match[1]);
  if (pid <= 1) {
    return { safe: false, reason: 'refusing to target pid 0 or 1' };
  }
  return { safe: true, pid };
}

/**
 * Decides which of the requested pids may actually be signalled: only those
 * with a matching, currently-verified ownership record. Every other pid is
 * returned as `needsHumanConfirmation` — the harness never signals a
 * process it cannot prove it started, and never widens a kill to "whatever
 * matches a name" to compensate.
 */
export function planSafeSignal(records, lookups) {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const verified = [];
  const needsHumanConfirmation = [];
  for (const lookup of lookups) {
    const record = byPid.get(lookup.pid);
    if (!record) {
      needsHumanConfirmation.push({ pid: lookup.pid, reason: 'no ownership record for this pid' });
      continue;
    }
    const check = verifyStillOwned(record, lookup.current);
    if (check.owned && check.confidence === 'high') {
      verified.push({ pid: lookup.pid, role: record.role, confidence: check.confidence });
    } else if (check.owned && check.confidence === 'low') {
      // A cmdline-only match is still surfaced for human confirmation rather
      // than auto-signalled — pid reuse cannot be ruled out without a start time.
      needsHumanConfirmation.push({ pid: lookup.pid, reason: check.reason, role: record.role });
    } else {
      needsHumanConfirmation.push({ pid: lookup.pid, reason: check.reason });
    }
  }
  return { verified, needsHumanConfirmation };
}
