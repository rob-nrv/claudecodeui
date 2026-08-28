// Filesystem access for the local-server marker. Kept apart from the parsing and
// state rules so those stay pure and cheap to test, and so a controller can point
// the store at a different home directory without touching the real one.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type LocalServerMarker,
  type RuntimeIdentity,
  parseLocalServerMarker,
  resolveLocalServerMarkerPath,
} from './runtime-marker.js';

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createLocalServerMarkerStore(homeDirectory: string = os.homedir()) {
  const markerPath = resolveLocalServerMarkerPath(homeDirectory);

  return {
    markerPath,

    /** Returns the marker on disk, or null when it is absent or unreadable. */
    async read(): Promise<LocalServerMarker | null> {
      try {
        return parseLocalServerMarker(JSON.parse(await fs.readFile(markerPath, 'utf8')));
      } catch {
        return null;
      }
    },

    async write(marker: LocalServerMarker): Promise<void> {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    },

    /**
     * Removes the marker only when it still describes the caller's own instance.
     * A shutting-down server that has already been replaced must leave the newer
     * server's marker alone, otherwise a restart erases the record of the runtime
     * that is actually listening. Identity is compared first because PIDs are
     * recycled; the PID comparison is only the fallback for pre-identity markers.
     */
    async removeIfOwnedBy(identity: RuntimeIdentity): Promise<boolean> {
      const marker = await this.read();
      if (marker) {
        const owned = marker.instanceId
          ? marker.instanceId === identity.instanceId
          : marker.pid === identity.pid;
        if (!owned) return false;
      }

      try {
        await fs.unlink(markerPath);
        return true;
      } catch (error) {
        if (isMissingFileError(error)) return false;
        throw error;
      }
    },
  };
}

export type LocalServerMarkerStore = ReturnType<typeof createLocalServerMarkerStore>;
