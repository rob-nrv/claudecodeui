// Docs <-> CLI contract (FT-M09-R1): the operator guides must only use node
// commands, flags, ranges, scripts and entrypoints that actually exist, clean up
// only HC-06-scoped paths, and embed nothing secret.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NODE_AGENT_CLI_COMMANDS, NODE_AGENT_CLI_FLAGS, parseResourcePolicyFlags } from '@/modules/node-agent/node-agent.command.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOCS = ['docs/android-runtime-node.md', 'docs/remote-access-and-runtime-nodes.md'];

async function readDoc(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

/** Lines inside fenced code blocks, with backslash continuations joined. */
function codeLines(markdown: string): string[] {
  const lines: string[] = [];
  let inBlock = false;
  let pending = '';
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) continue;
    const line = raw.trim();
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(`${pending}${line}`);
    pending = '';
  }
  return lines;
}

test('every documented `cloudcli node` command and flag exists in the CLI', async () => {
  const commands = new Set<string>(NODE_AGENT_CLI_COMMANDS);
  const flags = new Set(NODE_AGENT_CLI_FLAGS);
  let checked = 0;
  for (const doc of DOCS) {
    for (const line of codeLines(await readDoc(doc))) {
      const match = /(?:cli\.js|\bcloudcli)\s+node\s+([a-z-]+)(.*)$/.exec(line);
      if (!match) continue;
      checked += 1;
      assert.ok(commands.has(match[1]), `${doc}: unknown node command "${match[1]}" in: ${line}`);
      for (const flag of match[2].matchAll(/--([a-z][a-z-]*)/g)) {
        assert.ok(flags.has(flag[1]), `${doc}: unknown flag --${flag[1]} in: ${line}`);
      }
    }
    for (const row of (await readDoc(doc)).split(/\r?\n/).filter((line) => /^\|\s*`--/.test(line))) {
      for (const flag of row.split('|')[1].matchAll(/`--([a-z][a-z-]*)/g)) {
        assert.ok(flags.has(flag[1]), `${doc}: table documents unknown flag --${flag[1]}`);
      }
    }
  }
  assert.ok(checked >= 5, 'the guides still show real node commands');

  const combined = (await Promise.all(DOCS.map(readDoc))).join('\n');
  for (const flag of NODE_AGENT_CLI_FLAGS) {
    assert.ok(combined.includes(`--${flag}`), `--${flag} exists in the CLI but no guide documents it`);
  }
  for (const command of NODE_AGENT_CLI_COMMANDS) {
    assert.match(combined, new RegExp(`node ${command}\\b`), `node ${command} is not documented`);
  }
});

test('documented governor ranges match the flag parser, and scripts and entrypoints exist', async () => {
  const android = await readDoc('docs/android-runtime-node.md');
  const range = /`--max-concurrent-runs <(\d+)-(\d+)>`/.exec(android);
  assert.ok(range, 'the concurrency range is documented');
  const [min, max] = [Number(range[1]), Number(range[2])];
  assert.equal(parseResourcePolicyFlags({ 'max-concurrent-runs': String(min) }).ok, true);
  assert.equal(parseResourcePolicyFlags({ 'max-concurrent-runs': String(max) }).ok, true);
  assert.equal(parseResourcePolicyFlags({ 'max-concurrent-runs': String(min - 1) }).ok, false);
  assert.equal(parseResourcePolicyFlags({ 'max-concurrent-runs': String(max + 1) }).ok, false);
  assert.match(android, /--min-free-storage-mb <n>`[^|]*\|\s*512 \(0 = off\)/);

  const packageJson = JSON.parse(await readDoc('package.json')) as { scripts: Record<string, string>; bin: Record<string, string> };
  for (const doc of DOCS) {
    for (const script of (await readDoc(doc)).matchAll(/npm run ([a-z:-]+)/g)) {
      assert.ok(packageJson.scripts[script[1]], `${doc}: npm run ${script[1]} does not exist`);
    }
  }
  assert.ok(android.includes(packageJson.bin.cloudcli), 'the guide runs the real CLI entrypoint');
});

test('cleanup commands stay scoped to HC-06, and the guides embed no secret or private evidence', async () => {
  for (const doc of DOCS) {
    const markdown = await readDoc(doc);
    for (const line of codeLines(markdown)) {
      if (/\brm\s+-rf\b|proot-distro\s+remove\b/.test(line)) {
        assert.match(line, /hc06/, `${doc}: cleanup not scoped to HC-06: ${line}`);
      }
      assert.doesNotMatch(line, /proot-distro\s+(restore|reset)\b/, `${doc}: destructive proot-distro command: ${line}`);
    }
    assert.doesNotMatch(markdown, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(markdown, /\bsk-ant-[A-Za-z0-9_-]{10,}/);
    assert.doesNotMatch(markdown.replace(/XXXX-XXXX-XXXX/g, ''), /\b[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}\b/, `${doc}: looks like a real one-time code`);
    assert.doesNotMatch(markdown, /claudecodeui-ftm08/, `${doc}: the HC-05 evidence path must not become an instruction`);
  }
});
