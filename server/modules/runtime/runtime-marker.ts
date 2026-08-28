// Runtime identity: the evidence a runtime controller needs to tell "the CloudCLI
// server I started is online" apart from "something else is listening on that port"
// and "a marker file survived a server that is long dead".
//
// A PID alone cannot carry that proof: PIDs are recycled, and a marker written by a
// crashed server keeps its PID field forever. Every process therefore mints a random
// instance id at startup, publishes it both in the marker file and on /health, and a
// controller treats the runtime as its own only when the two match.
import crypto from 'node:crypto';
import path from 'node:path';

/** Identity minted once per server process and published as startup evidence. */
export type RuntimeIdentity = {
  instanceId: string;
  pid: number;
  startedAt: string;
};

/** Contents of ~/.cloudcli/local-server.json. */
export type LocalServerMarker = RuntimeIdentity & {
  host: string;
  port: number;
  url: string;
  installMode: string;
  appRoot: string;
  version: string | null;
  updatedAt: string;
};

/** The runtime-identity block a live server publishes on its public /health route. */
export type RuntimeHealth = {
  instanceId: string | null;
  startedAt: string | null;
};

export const LOCAL_SERVER_MARKER_RELATIVE_PATH = ['.cloudcli', 'local-server.json'] as const;

/**
 * Builds the address to probe for health from a marker's own bind details.
 *
 * Deliberately not `marker.url`: that field carries the display host
 * ("localhost") meant for humans and browsers. Probing "localhost" is a real
 * source of false STOPPED, because it can resolve to ::1 first while the server
 * bound 127.0.0.1, and the probe then reads ECONNREFUSED from a perfectly
 * healthy runtime. A wildcard bind is probed over loopback for the same reason.
 */
export function resolveHealthUrl(marker: Pick<LocalServerMarker, 'host' | 'port'>): string {
  const host = marker.host === '::1' || marker.host === '[::1]'
    ? '[::1]'
    : marker.host === '0.0.0.0' || marker.host === '::' || marker.host === 'localhost'
      ? '127.0.0.1'
      : marker.host;
  return `http://${host}:${marker.port}/health`;
}

/** Resolves the marker path for a home directory so callers never hardcode it. */
export function resolveLocalServerMarkerPath(homeDirectory: string): string {
  return path.join(homeDirectory, ...LOCAL_SERVER_MARKER_RELATIVE_PATH);
}

/** Mints the identity for the current process. Called exactly once at startup. */
export function createRuntimeIdentity(now: Date = new Date()): RuntimeIdentity {
  return {
    instanceId: crypto.randomUUID(),
    pid: process.pid,
    startedAt: now.toISOString(),
  };
}

type MarkerLocation = {
  host: string;
  port: number;
  url: string;
  installMode: string;
  appRoot: string;
  version: string | null;
};

/** Builds the marker payload written once the server is actually listening. */
export function buildLocalServerMarker(
  identity: RuntimeIdentity,
  location: MarkerLocation,
  now: Date = new Date(),
): LocalServerMarker {
  return {
    ...identity,
    ...location,
    updatedAt: now.toISOString(),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readPort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Parses a marker read from disk, tolerating markers written by older servers that
 * predate `instanceId`/`startedAt`. Those parse successfully with null identity
 * fields so an upgrade never looks like a corrupt runtime; callers then downgrade
 * to "cannot verify ownership" rather than rejecting the runtime outright.
 */
export function parseLocalServerMarker(raw: unknown): LocalServerMarker | null {
  const record = readRecord(raw);
  if (!record) return null;

  const port = readPort(record.port);
  const host = readString(record.host);
  const url = readString(record.url) ?? (host && port ? `http://${host}:${port}` : null);
  const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null;
  if (!port || !host || !url || pid === null) return null;

  return {
    instanceId: readString(record.instanceId) ?? '',
    pid,
    startedAt: readString(record.startedAt) ?? readString(record.updatedAt) ?? '',
    host,
    port,
    url,
    installMode: readString(record.installMode) ?? 'unknown',
    appRoot: readString(record.appRoot) ?? '',
    version: readString(record.version),
    updatedAt: readString(record.updatedAt) ?? '',
  };
}

/**
 * Parses a /health response. Returns null unless the responder is recognisably a
 * CloudCLI server, so an unrelated process squatting the port never reads as online.
 */
export function parseRuntimeHealth(raw: unknown): RuntimeHealth | null {
  const record = readRecord(raw);
  if (!record || record.status !== 'ok' || typeof record.installMode !== 'string') return null;

  const runtime = readRecord(record.runtime);
  return {
    instanceId: runtime ? readString(runtime.instanceId) : null,
    startedAt: runtime ? readString(runtime.startedAt) : null,
  };
}
