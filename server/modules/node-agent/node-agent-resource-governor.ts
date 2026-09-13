// Minimal Resource Governor for a node agent (FT-M09). It bounds how much work
// a node accepts and states why it refuses, from portable signals only:
// active CloudCLI runs, free storage in the workspace root, and — where the
// OS exposes it without root or extra apps — the battery. Unknown signals are
// reported as unknown and never block; nothing is reported healthy by default.
import fs from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeNodeResourceReport } from '@/shared/types.js';

export type ResourceGovernorPolicy = {
  maxConcurrentRuns: number;
  /** 0 disables the storage floor. */
  minFreeStorageBytes: number;
  /** null disables the battery floor; it only applies while the battery is known and not charging. */
  minBatteryPercent: number | null;
};

export const DEFAULT_RESOURCE_GOVERNOR_POLICY: ResourceGovernorPolicy = {
  maxConcurrentRuns: 2,
  minFreeStorageBytes: 512 * 1024 * 1024,
  minBatteryPercent: null,
};

export type NodeResourceSignals = {
  storage: { state: 'known'; freeBytes: number } | { state: 'unknown'; reason: string };
  battery: { state: 'known'; percent: number; charging: boolean | null } | { state: 'unknown'; reason: string };
  thermal: { state: 'known'; celsius: number } | { state: 'unknown'; reason: string };
};

export type ResourceRefusalCode = 'RESOURCE_CONCURRENCY_LIMIT' | 'RESOURCE_STORAGE_LOW' | 'RESOURCE_BATTERY_LOW';

type Evaluation = {
  admission: RuntimeNodeResourceReport['admission'];
  restriction: RuntimeNodeResourceReport['restriction'];
  refusal: ResourceRefusalCode | null;
};

/**
 * Deterministic admission, checked in a fixed order: concurrency, storage,
 * battery. Consumed by the executor at every run start and by the report.
 */
export function evaluateResourceAdmission(policy: ResourceGovernorPolicy, activeRuns: number, signals: NodeResourceSignals): Evaluation {
  if (activeRuns >= policy.maxConcurrentRuns) {
    return { admission: 'at_capacity', restriction: null, refusal: 'RESOURCE_CONCURRENCY_LIMIT' };
  }
  if (policy.minFreeStorageBytes > 0 && signals.storage.state === 'known' && signals.storage.freeBytes < policy.minFreeStorageBytes) {
    return { admission: 'restricted', restriction: 'storage_low', refusal: 'RESOURCE_STORAGE_LOW' };
  }
  if (
    policy.minBatteryPercent !== null
    && signals.battery.state === 'known'
    && signals.battery.charging !== true
    && signals.battery.percent < policy.minBatteryPercent
  ) {
    return { admission: 'restricted', restriction: 'battery_low', refusal: 'RESOURCE_BATTERY_LOW' };
  }
  return { admission: 'accepting', restriction: null, refusal: null };
}

export function buildResourceReport(policy: ResourceGovernorPolicy, activeRuns: number, signals: NodeResourceSignals): RuntimeNodeResourceReport {
  const evaluation = evaluateResourceAdmission(policy, activeRuns, signals);
  return {
    admission: evaluation.admission,
    restriction: evaluation.restriction,
    activeRuns,
    maxConcurrentRuns: policy.maxConcurrentRuns,
    storage: signals.storage.state === 'known'
      ? { state: 'known', freeBytes: signals.storage.freeBytes, minFreeBytes: policy.minFreeStorageBytes }
      : signals.storage,
    battery: signals.battery.state === 'known'
      ? { ...signals.battery, minPercent: policy.minBatteryPercent }
      : signals.battery,
    thermal: signals.thermal,
  };
}

type SignalReaders = {
  statfs?: (directory: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  readdir?: (directory: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
  platform?: string;
};

const POWER_SUPPLY_ROOT = '/sys/class/power_supply';

async function readStorage(workspaceRoot: string, readers: SignalReaders): Promise<NodeResourceSignals['storage']> {
  const statfs = readers.statfs ?? (typeof fs.statfs === 'function' ? (directory: string) => fs.statfs(directory) : null);
  if (!statfs) {
    return { state: 'unknown', reason: 'statfs_unsupported' };
  }
  try {
    const stats = await statfs(workspaceRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isSafeInteger(freeBytes) && freeBytes >= 0 ? { state: 'known', freeBytes } : { state: 'unknown', reason: 'storage_unreadable' };
  } catch {
    return { state: 'unknown', reason: 'storage_unreadable' };
  }
}

async function readBattery(readers: SignalReaders): Promise<NodeResourceSignals['battery']> {
  const platform = readers.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'android') {
    return { state: 'unknown', reason: 'no_portable_source' };
  }
  const readdir = readers.readdir ?? ((directory: string) => fs.readdir(directory));
  const readFile = readers.readFile ?? ((file: string) => fs.readFile(file, 'utf8'));
  let supplies: string[];
  try {
    supplies = await readdir(POWER_SUPPLY_ROOT);
  } catch {
    // Android usually denies this to apps: that is "unknown", not "no battery".
    return { state: 'unknown', reason: 'battery_unreadable' };
  }
  for (const supply of supplies.slice(0, 32)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(supply)) continue;
    const base = path.posix.join(POWER_SUPPLY_ROOT, supply);
    try {
      if ((await readFile(`${base}/type`)).trim() !== 'Battery') continue;
      const percent = Number((await readFile(`${base}/capacity`)).trim());
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) continue;
      const status = (await readFile(`${base}/status`).catch(() => '')).trim();
      const charging = status === 'Charging' || status === 'Full' ? true : status === 'Discharging' || status === 'Not charging' ? false : null;
      return { state: 'known', percent, charging };
    } catch {
      // Try the next supply.
    }
  }
  return { state: 'unknown', reason: 'no_battery_reported' };
}

/**
 * Reads the governor's signals once. Thermal state has no portable,
 * permission-free source across Android, Linux and Windows, so it is reported
 * as unknown rather than approximated from an arbitrary sensor zone.
 */
export async function readNodeResourceSignals(workspaceRoot: string, readers: SignalReaders = {}): Promise<NodeResourceSignals> {
  const [storage, battery] = await Promise.all([readStorage(workspaceRoot, readers), readBattery(readers)]);
  return { storage, battery, thermal: { state: 'unknown', reason: 'no_portable_source' } };
}

/** The governor the executor consumes; signal reading is injectable for tests. */
export type NodeResourceGovernor = {
  readonly policy: ResourceGovernorPolicy;
  /** Signal-based admission for a run whose concurrency slot was already reserved. */
  admitSignals(activeRunsBeforeThis: number): Promise<ResourceRefusalCode | null>;
  report(activeRuns: number): Promise<RuntimeNodeResourceReport>;
};

export function createNodeResourceGovernor(options: {
  policy: ResourceGovernorPolicy;
  readSignals: () => Promise<NodeResourceSignals>;
}): NodeResourceGovernor {
  return {
    policy: options.policy,
    async admitSignals(activeRunsBeforeThis) {
      return evaluateResourceAdmission(options.policy, activeRunsBeforeThis, await options.readSignals()).refusal;
    },
    async report(activeRuns) {
      return buildResourceReport(options.policy, activeRuns, await options.readSignals());
    },
  };
}
