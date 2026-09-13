// Deterministic sync classification for files in a project workspace (FT-M09).
// Nothing is uploaded in FT-M09: this is the security contract a future
// Workspace Snapshot / Sync must apply before any file leaves a RuntimeNode.
//
// Precedence is fixed: secret > user_excluded > local_only > syncable. A secret
// rule can never be overridden by a project's own configuration, and a
// `.gitignore` entry is neither required nor trusted to keep a secret out.

/**
 * - `syncable`: project content a checkpoint may carry.
 * - `local_only`: regenerable or machine-specific (dependencies, build output,
 *   caches, Git metadata that Git itself transports).
 * - `secret`: denied by default; never read into a checkpoint, never listed by name.
 * - `user_excluded`: excluded by the project's own policy patterns.
 */
export type WorkspaceSyncClass = 'syncable' | 'local_only' | 'secret' | 'user_excluded';

export type WorkspaceSyncPolicy = {
  version: 1;
  /** Project-level glob patterns (`*`, `**`, trailing `/` for folders), relative to the project root. */
  userExcludePatterns: string[];
};

export type WorkspaceSyncClassification = {
  syncClass: WorkspaceSyncClass;
  /** Stable id of the rule that decided, for evidence and tests; never a file name. */
  rule: string;
};

export const DEFAULT_WORKSPACE_SYNC_POLICY: WorkspaceSyncPolicy = { version: 1, userExcludePatterns: [] };

const MAX_USER_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 256;

/** Folder names whose whole subtree holds credentials or machine identity. */
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.cloudcli', '.azure', '.config/gcloud']);

/** Exact file names that hold credentials in common tools. */
const SECRET_FILE_NAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'credential.json',
  '.credentials.json',
  'auth.db',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'terraform.tfvars',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
]);

/** `.env.*` variants that are templates by convention and hold no values. */
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.tfstate', '.ppk', '.asc', '.gpg']);

const SECRET_NAME_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'secret:ssh_private_key', pattern: /^id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?$/ },
  { rule: 'secret:gcp_client_secret', pattern: /^client_secret.*\.json$/ },
  { rule: 'secret:service_account', pattern: /^service[-_]account.*\.json$/ },
  { rule: 'secret:tfstate_backup', pattern: /\.tfstate\.backup$/ },
];

/** Project-relative files that are credentials even inside otherwise syncable folders. */
const SECRET_RELATIVE_PATHS = new Set(['.claude/settings.local.json', '.claude/.credentials.json']);

const LOCAL_ONLY_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.vite',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.terraform',
  '.idea',
  'tmp',
  'temp',
  '.tmp',
]);

const LOCAL_ONLY_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const LOCAL_ONLY_EXTENSIONS = new Set(['.log', '.tmp', '.swp', '.swo', '.pyc', '.pyo']);

/**
 * Normalizes a workspace-relative path to POSIX segments. Returns null for
 * anything that is not a plain relative path inside the workspace (absolute,
 * drive-qualified, traversal, NUL): such a path can never be classified as
 * syncable.
 */
export function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) {
    return null;
  }
  const slashed = value.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    return null;
  }
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return null;
  }
  return segments.join('/');
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index).toLowerCase() : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converts one project exclude glob to an anchored regular expression, or null when unusable. */
function compileUserPattern(pattern: string): RegExp | null {
  const normalized = pattern.trim().replace(/\\/g, '/');
  if (!normalized || normalized.length > MAX_PATTERN_LENGTH || normalized.includes('\0') || normalized.split('/').includes('..')) {
    return null;
  }
  const directoryOnly = normalized.endsWith('/');
  const anchored = normalized.startsWith('/');
  const body = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!body) {
    return null;
  }
  let source = '';
  const parts = body.split('/');
  parts.forEach((part, index) => {
    if (part === '**') {
      source += index === parts.length - 1 ? '.*' : '(?:.*/)?';
      return;
    }
    source += escapeRegExp(part).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (index < parts.length - 1) {
      source += '/';
    }
  });
  // A pattern without a slash matches at any depth, like .gitignore.
  const prefix = anchored || body.includes('/') ? '^' : '^(?:.*/)?';
  const suffix = directoryOnly ? '/.*$' : '(?:/.*)?$';
  try {
    return new RegExp(`${prefix}${source}${suffix}`);
  } catch {
    return null;
  }
}

/** Validates and bounds a project's exclude patterns; invalid entries are reported, never silently widened. */
export function normalizeWorkspaceSyncPolicy(value: unknown): { policy: WorkspaceSyncPolicy; rejectedPatterns: number } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const raw = Array.isArray(record.userExcludePatterns) ? record.userExcludePatterns : [];
  const accepted: string[] = [];
  let rejectedPatterns = 0;
  for (const entry of raw.slice(0, MAX_USER_PATTERNS)) {
    if (typeof entry === 'string' && compileUserPattern(entry)) {
      accepted.push(entry.trim());
    } else {
      rejectedPatterns += 1;
    }
  }
  rejectedPatterns += Math.max(0, raw.length - MAX_USER_PATTERNS);
  return { policy: { version: 1, userExcludePatterns: accepted }, rejectedPatterns };
}

/**
 * Classifies one workspace-relative path. Name-based only: content that looks
 * secret is escalated separately by `detectSecretContentMarkers`. Detection is
 * deliberately conservative and still not perfect — a checkpoint must also
 * honour the project's own exclusions.
 */
export function classifyWorkspacePath(relativePath: unknown, policy: WorkspaceSyncPolicy = DEFAULT_WORKSPACE_SYNC_POLICY): WorkspaceSyncClassification {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    // Unclassifiable paths are denied: never syncable by accident.
    return { syncClass: 'secret', rule: 'secret:invalid_path' };
  }
  const segments = normalized.split('/');
  const name = segments[segments.length - 1];
  const lowerName = name.toLowerCase();
  const directories = segments.slice(0, -1);

  for (let index = 0; index < directories.length; index += 1) {
    const single = directories[index];
    const pair = index + 1 < directories.length ? `${single}/${directories[index + 1]}` : null;
    if (SECRET_DIRECTORIES.has(single) || (pair && SECRET_DIRECTORIES.has(pair))) {
      return { syncClass: 'secret', rule: 'secret:credential_directory' };
    }
  }
  if (SECRET_RELATIVE_PATHS.has(normalized)) {
    return { syncClass: 'secret', rule: 'secret:claude_local_settings' };
  }
  if (SECRET_FILE_NAMES.has(lowerName)) {
    return { syncClass: 'secret', rule: 'secret:credential_file' };
  }
  if (lowerName.startsWith('.env.')) {
    const suffix = lowerName.slice('.env.'.length);
    if (!ENV_TEMPLATE_SUFFIXES.has(suffix)) {
      return { syncClass: 'secret', rule: 'secret:env_file' };
    }
  }
  if (SECRET_EXTENSIONS.has(extensionOf(lowerName))) {
    return { syncClass: 'secret', rule: 'secret:key_material' };
  }
  for (const { rule, pattern } of SECRET_NAME_PATTERNS) {
    if (pattern.test(lowerName)) {
      return { syncClass: 'secret', rule };
    }
  }

  for (const pattern of policy.userExcludePatterns) {
    const compiled = compileUserPattern(pattern);
    if (compiled && compiled.test(normalized)) {
      return { syncClass: 'user_excluded', rule: 'user:exclude_pattern' };
    }
  }

  if (directories.some((directory) => LOCAL_ONLY_DIRECTORIES.has(directory))) {
    return { syncClass: 'local_only', rule: 'local:regenerable_directory' };
  }
  if (LOCAL_ONLY_FILE_NAMES.has(name) || LOCAL_ONLY_EXTENSIONS.has(extensionOf(lowerName)) || /^npm-debug\.log/.test(lowerName)) {
    return { syncClass: 'local_only', rule: 'local:regenerable_file' };
  }
  return { syncClass: 'syncable', rule: 'syncable:project_content' };
}

const SECRET_CONTENT_MARKERS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'private_key_block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai_project_key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { id: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { id: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'claude_oauth_token', pattern: /\bsk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}/ },
];

/** Bytes of a file inspected for secret markers; the rest of a large file is not scanned. */
export const SECRET_MARKER_SCAN_BYTES = 256 * 1024;

/**
 * Best-effort content check for high-confidence credential markers. Returns
 * marker ids only — never the matched text. An empty result does NOT prove a
 * file is free of secrets.
 */
export function detectSecretContentMarkers(content: string | Buffer): string[] {
  const text = typeof content === 'string'
    ? content.slice(0, SECRET_MARKER_SCAN_BYTES)
    : content.subarray(0, SECRET_MARKER_SCAN_BYTES).toString('latin1');
  return SECRET_CONTENT_MARKERS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}
