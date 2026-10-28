import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER, tempProject } from './helpers.js';

const cli = (...args) => spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', timeout: 30000 });

function tempConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cem-desktop-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return { dir, file };
}

test('install creates the config with an absolute node + script path and lean mode', () => {
  const { file } = tempConfig();
  const root = tempProject();
  const r = cli('install', '--config', file, '--root', root, '--windows-sandbox', 'unelevated');
  assert.equal(r.status, 0, r.stderr);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.codex;
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [SERVER]);
  assert.deepEqual(entry.env, {
    CODEX_MCP_ALLOWED_ROOTS: root,
    CODEX_MCP_DEFAULT_CWD: root,
    CODEX_MCP_LEAN: '1',
    CODEX_MCP_WINDOWS_SANDBOX: 'unelevated',
  });
  assert.match(r.stdout, /Fully quit Claude Desktop/);
});

test('install keeps everything else in the file, merges env and writes a backup', () => {
  const original = {
    coworkUserFilesPath: 'C:\\Users\\me\\Claude',
    preferences: { sidebarMode: 'chat' },
    mcpServers: {
      other: { command: 'x' },
      codex: { command: 'old-node', args: ['old.js'], env: { CODEX_MCP_MAX_CONCURRENT: '2', CODEX_MCP_LEAN: '1' } },
    },
  };
  const { dir, file } = tempConfig(JSON.stringify(original));
  const r = cli('install', '--config', file, '--no-lean');
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.coworkUserFilesPath, original.coworkUserFilesPath);
  assert.deepEqual(data.preferences, original.preferences);
  assert.deepEqual(data.mcpServers.other, { command: 'x' });
  assert.equal(data.mcpServers.codex.command, process.execPath);
  assert.deepEqual(data.mcpServers.codex.env, { CODEX_MCP_MAX_CONCURRENT: '2' }, 'existing env kept, lean removed by --no-lean');
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')), original);
  assert.match(r.stdout, /updated the existing entry/);
});

test('invalid JSON, bad options and --dry-run leave the file untouched', () => {
  const { file } = tempConfig('{ not json');
  let r = cli('install', '--config', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');

  const ok = tempConfig('{"a":1}');
  r = cli('install', '--config', ok.file, '--dry-run');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Would write mcpServers\.codex/);
  assert.equal(fs.readFileSync(ok.file, 'utf8'), '{"a":1}');

  for (const bad of [['--root', path.join(os.tmpdir(), 'no-such-dir-xyz')], ['--windows-sandbox', 'off'], ['--name', 'a b'], ['--bogus']]) {
    r = cli('install', '--config', ok.file, ...bad);
    assert.equal(r.status, 1, bad.join(' '));
    assert.match(r.stderr, /^error: /);
  }
  assert.equal(fs.readFileSync(ok.file, 'utf8'), '{"a":1}');
});

test('uninstall removes only this entry', () => {
  const { file } = tempConfig(JSON.stringify({ x: 1, mcpServers: { codex: { command: 'n' }, keep: { command: 'k' } } }));
  let r = cli('uninstall', '--config', file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 1, mcpServers: { keep: { command: 'k' } } });
  r = cli('uninstall', '--config', file);
  assert.match(r.stdout, /Nothing to remove/);
});

test('Windows: an MSIX-packaged config location wins over %APPDATA%', async () => {
  const { desktopConfigPath } = await import('../src/install.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cem-win-'));
  const env = { APPDATA: path.join(base, 'Roaming'), LOCALAPPDATA: path.join(base, 'Local') };
  // No Store install: classic %APPDATA% path.
  assert.equal(desktopConfigPath(env, 'win32'), path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
  // Store install present: its virtualised AppData is used.
  const storeDir = path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Packages', 'ClaudeOther_x', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  assert.equal(desktopConfigPath(env, 'win32'), path.join(storeDir, 'claude_desktop_config.json'));
});

test('unknown commands are rejected instead of starting the server', () => {
  const r = cli('instal');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "instal"/);
});
