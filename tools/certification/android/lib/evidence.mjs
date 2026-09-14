// Evidence-folder management for the Android RuntimeNode certification
// harness. This is the one module in `lib/` that touches the filesystem —
// everything else is pure decision logic. Tests use a real temporary
// directory (no device needed) so the atomic-write and never-overwrite
// guarantees are exercised for real, not mocked away.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const POINTER_FILE = '.certification-current';
const MANIFEST_FILE = 'manifest.json';

/**
 * Same high-confidence, curated key-name check as
 * lib/doctor-report.mjs's containsForbiddenField, generalized for any
 * evidence object (chat/session responses, workspace-mapping bodies, ...),
 * not just a doctor report. Kept as a separate copy rather than a shared
 * import so each file states its own contract explicitly; the underlying
 * rule ("never store a secret-shaped field") is the same everywhere.
 */
// Deliberately NOT a bare "code" — REST/WS error envelopes legitimately
// carry a `code` field (e.g. "RUNTIME_NODE_OFFLINE", "RESOURCE_STORAGE_LOW")
// that is exactly the evidence these tests need to keep; only the specific
// one-time enrollment code is a secret.
const FORBIDDEN_KEY_PATTERN = /privateKey|publicKey|credentialJson|enrollmentCode|oneTimeCode|pairingCode|token|password|secret|apiKey|accountEmail|organizationId|authorization/i;

export function findForbiddenField(value, keyPath = []) {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenField(value[index], [...keyPath, index]);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      return [...keyPath, key].join('.');
    }
    const found = findForbiddenField(value[key], [...keyPath, key]);
    if (found) return found;
  }
  return null;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWriteFile(target, contents) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, target);
}

/**
 * Resolves the certification evidence directory under `hc06Dir` (normally
 * `~/hc06`). With `resume` (the default), an existing campaign — recorded
 * in `.certification-current` — is reused so evidence accumulates across
 * separate invocations instead of starting a fresh, disconnected folder
 * every time the runner is launched. Pass `resume: false` only to
 * deliberately start a new campaign alongside the old one (the old one is
 * never touched, let alone removed).
 */
export async function resolveCertificationDir(hc06Dir, options = {}) {
  const now = options.now ?? (() => new Date());
  const resume = options.resume ?? true;
  const pointerPath = path.join(hc06Dir, POINTER_FILE);

  if (resume) {
    try {
      const pointed = (await readFile(pointerPath, 'utf8')).trim();
      if (pointed) {
        const resolved = path.join(hc06Dir, pointed);
        await mkdir(resolved, { recursive: true }); // no-op if it already exists; never removes anything
        return { dir: resolved, name: pointed, resumed: true };
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  const name = `certification-${now().toISOString().replace(/[:.]/g, '-')}`;
  const resolved = path.join(hc06Dir, name);
  await mkdir(resolved, { recursive: true });
  await atomicWriteFile(pointerPath, `${name}\n`);
  return { dir: resolved, name, resumed: false };
}

/**
 * Writes one evidence file. Refuses to overwrite an existing file (matching
 * `cloudcli node doctor --output`'s own convention) and refuses to write
 * anything matching the forbidden-field check — both failures throw rather
 * than silently doing something unsafe, since a caller catching this
 * should stop and reconsider, not retry with a different name automatically.
 */
export async function writeEvidenceFile(dir, name, data) {
  const target = path.join(dir, name);
  if (await pathExists(target)) {
    throw new Error(`writeEvidenceFile: ${name} already exists in ${dir} — evidence is append-only, choose a new (e.g. timestamped) name`);
  }
  const forbidden = findForbiddenField(data);
  if (forbidden) {
    throw new Error(`writeEvidenceFile: refusing to write ${name} — field "${forbidden}" looks like a secret`);
  }
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(target, serialized, { mode: 0o600 });
  return target;
}

/**
 * Appends one entry to manifest.json (creating it on first use). The write
 * is atomic (temp file + rename) and the manifest is read-merge-written
 * every time, so a crash mid-write can never leave a half-written manifest,
 * and an entry once appended is never edited or removed by this function.
 */
export async function appendManifestEntry(dir, entry) {
  const target = path.join(dir, MANIFEST_FILE);
  let manifest = { schema: 'cloudcli.hc06-certification-manifest', version: 1, entries: [] };
  if (await pathExists(target)) {
    const raw = await readFile(target, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        manifest = parsed;
      }
    } catch {
      throw new Error(`appendManifestEntry: ${target} exists but is not valid JSON — investigate before continuing, do not overwrite it`);
    }
  }
  const forbidden = findForbiddenField(entry);
  if (forbidden) {
    throw new Error(`appendManifestEntry: refusing to append — field "${forbidden}" looks like a secret`);
  }
  manifest.entries.push({ ...entry, appendedAt: new Date().toISOString() });
  await atomicWriteFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readManifest(dir) {
  const target = path.join(dir, MANIFEST_FILE);
  if (!(await pathExists(target))) {
    return { schema: 'cloudcli.hc06-certification-manifest', version: 1, entries: [] };
  }
  return JSON.parse(await readFile(target, 'utf8'));
}
