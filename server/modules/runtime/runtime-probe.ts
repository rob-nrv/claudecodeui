// Evidence collection. Every source of truth is injected so the collection order
// and the degradation rules can be tested without a socket, a marker file, or a
// live process — and so an Android/Termux controller that can only reach the
// HTTP source reuses the exact same logic with liveness reporting "unknown".
import {
  type LocalServerMarker,
  type RuntimeHealth,
  parseRuntimeHealth,
  resolveHealthUrl,
} from './runtime-marker.js';
import type { RuntimeEvidence } from './runtime-status.js';

export type RuntimeProbeDependencies = {
  readMarker(): Promise<LocalServerMarker | null>;
  /** Resolves the parsed JSON body, or null when nothing usable answered. */
  fetchHealth(healthUrl: string): Promise<unknown>;
  /** True/false when the platform can tell, null when it cannot check at all. */
  isProcessAlive(pid: number): boolean | null;
};

export type RuntimeProbeOptions = {
  /**
   * Probed only when no marker exists, so a server started before markers were
   * written — or one whose marker was deleted — is still discovered instead of
   * being reported as stopped.
   */
  fallbackHealthUrl?: string;
};

async function readHealth(
  fetchHealth: RuntimeProbeDependencies['fetchHealth'],
  healthUrl: string,
): Promise<RuntimeHealth | null> {
  try {
    return parseRuntimeHealth(await fetchHealth(healthUrl));
  } catch {
    // Unreachable, timed out, or not JSON. All mean the same thing here: no
    // health evidence. The state rules decide what that implies.
    return null;
  }
}

export function createRuntimeProbe(dependencies: RuntimeProbeDependencies) {
  return {
    async collect(options: RuntimeProbeOptions = {}): Promise<RuntimeEvidence> {
      const marker = await dependencies.readMarker();

      if (!marker) {
        const health = options.fallbackHealthUrl
          ? await readHealth(dependencies.fetchHealth, options.fallbackHealthUrl)
          : null;
        return { marker: null, health, processAlive: null };
      }

      const health = await readHealth(dependencies.fetchHealth, resolveHealthUrl(marker));
      // Liveness only matters when health is silent, and it is the most
      // expensive signal, so it is never gathered for a runtime that just
      // answered.
      const processAlive = health ? null : dependencies.isProcessAlive(marker.pid);

      return { marker, health, processAlive };
    },
  };
}

export type RuntimeProbe = ReturnType<typeof createRuntimeProbe>;
