import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FAKE_CODEX, SERVER } from './helpers.js';

const run = (args, env = {}) =>
  spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', env: { ...process.env, CODEX_MCP_CODEX_PATH: FAKE_CODEX, ...env }, timeout: 60000 });

test('--version and --help', () => {
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  assert.match(run(['--help']).stdout, /doctor --live/);
});

test('doctor reports the detected setup and passes the live check', () => {
  const plain = run(['doctor']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /codex version: 0\.163\.0/);
  const live = run(['doctor', '--live']);
  assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.match(live.stdout, /Live test passed/);
});

test('doctor fails clearly when Codex is missing', () => {
  const r = run(['doctor'], { CODEX_MCP_CODEX_PATH: path.join(os.tmpdir(), 'no-such-codex.js') });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT AVAILABLE/);
});
