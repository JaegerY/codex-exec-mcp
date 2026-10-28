import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecArgs, parseFeatures } from '../src/codex.js';
import { loadConfig } from '../src/config.js';
import { formatDuration, isWithin } from '../src/util.js';

const REAL_HELP_EXCERPT = `Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  review  Run a code review against the current repository

Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
  -C, --cd <DIR>
      --skip-git-repo-check
      --json
  -o, --output-last-message <FILE>
`;

test('parseFeatures reads the version and flags', () => {
  const f = parseFeatures('codex-cli 0.163.0\n', REAL_HELP_EXCERPT);
  assert.equal(f.version, '0.163.0');
  for (const k of ['json', 'outputLastMessage', 'cd', 'sandbox', 'skipGitRepoCheck', 'model', 'resume']) assert.equal(f[k], true, k);
  assert.equal(f.color, false);
  const old = parseFeatures('codex-cli 0.20.1', 'Usage: codex exec [PROMPT]\n  -m, --model <MODEL>\n');
  assert.equal(old.json, false);
  assert.equal(old.resume, false);
});

test('buildExecArgs puts every option before the subcommand and ends with "-"', () => {
  const f = parseFeatures('codex-cli 0.163.0', REAL_HELP_EXCERPT);
  const args = buildExecArgs(f, { lastMessageFile: '/tmp/x.txt', cwd: '/p', sandbox: 'workspace-write', skipGitRepoCheck: true, model: 'm1', extraArgs: ['-c', 'a=b'], sessionId: 's1' });
  assert.deepEqual(args, ['exec', '--json', '--output-last-message', '/tmp/x.txt', '--cd', '/p', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--model', 'm1', '-c', 'a=b', 'resume', 's1', '-']);
  const win = buildExecArgs(f, { cwd: 'C:\\p', sandbox: 'workspace-write', windowsSandbox: 'unelevated' });
  assert.deepEqual(win.slice(win.indexOf('-c'), win.indexOf('-c') + 2), ['-c', 'windows.sandbox="unelevated"']);
  assert.throws(() => loadConfig({ CODEX_MCP_WINDOWS_SANDBOX: 'off' }), /CODEX_MCP_WINDOWS_SANDBOX/);
  const plain = buildExecArgs(f, { cwd: '/p', sandbox: 'read-only', skipGitRepoCheck: false });
  assert.equal(plain.at(-1), '-');
  assert.ok(!plain.includes('resume'));
});

test('loadConfig validates input', () => {
  assert.equal(loadConfig({}).defaultSandbox, 'workspace-write');
  assert.throws(() => loadConfig({ CODEX_MCP_DEFAULT_SANDBOX: 'danger-full-access' }), /CODEX_MCP_ALLOW_DANGER/);
  assert.throws(() => loadConfig({ CODEX_MCP_EXTRA_ARGS: 'not json' }), /JSON array/);
  assert.throws(() => loadConfig({ CODEX_MCP_TIMEOUT_SEC: 'abc' }), /integer/);
  assert.equal(loadConfig({ CODEX_MCP_RUN_WAIT_SEC: '99999' }).runWaitSec, 3600);
});

test('isWithin handles prefixes and Windows case-insensitivity', () => {
  assert.equal(isWithin('/a/b/c', '/a/b', 'linux'), true);
  assert.equal(isWithin('/a/bc', '/a/b', 'linux'), false);
  assert.equal(isWithin('/a/b', '/a/b', 'linux'), true);
  assert.equal(isWithin('/A/B/c', '/a/b', 'linux'), false);
  assert.equal(isWithin('/A/B/c', '/a/b', 'win32'), true);
});

test('formatDuration', () => {
  assert.equal(formatDuration(500), '1s');
  assert.equal(formatDuration(92000), '1m32s');
  assert.equal(formatDuration(3_720_000), '1h02m');
});
