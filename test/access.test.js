import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER, startServer, tempProject, waitUntil } from './helpers.js';

const uri = (dir) => pathToFileURL(dir).href;

test('folders the client has open (MCP roots) are allowed automatically', async () => {
  const allowed = tempProject();
  const workspace = tempProject();
  const other = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  s.onServerRequest = (req) => (req.method === 'roots/list' ? { roots: [{ uri: uri(workspace), name: 'ws' }] } : undefined);
  try {
    await s.initialize('2025-06-18', { roots: { listChanged: true } });
    assert.ok(await waitUntil(() => s.serverRequests.some((r) => r.method === 'roots/list')), 'server asks for roots after initialized');

    const inRoot = await s.call('codex_run', { prompt: 'work', cwd: path.join(workspace) });
    assert.equal(inRoot.isError, false, inRoot.text);

    fs.mkdirSync(path.join(workspace, 'sub'));
    const nested = await s.call('workspace_read', { cwd: path.join(workspace, 'sub'), paths: ['.'] });
    assert.equal(nested.isError, false, 'subfolders of a root are allowed too');

    const outside = await s.call('codex_run', { prompt: 'work', cwd: other });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /outside CODEX_MCP_ALLOWED_ROOTS/);
    assert.match(outside.text, /roots: yes, elicitation: no/);

    const info = await s.call('codex_info', {});
    assert.match(info.text, /client: test 1; roots: yes, elicitation: no/);
    assert.ok(info.text.includes(`client roots (allowed automatically): ${workspace}`), info.text);
  } finally {
    await s.close();
  }
});

test('roots are re-read after notifications/roots/list_changed', async () => {
  const allowed = tempProject();
  const first = tempProject();
  const second = tempProject();
  let current = [first];
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  s.onServerRequest = (req) => (req.method === 'roots/list' ? { roots: current.map((d) => ({ uri: uri(d) })) } : undefined);
  try {
    await s.initialize('2025-06-18', { roots: { listChanged: true } });
    assert.equal((await s.call('workspace_read', { cwd: first, paths: ['.'] })).isError, false);
    assert.equal((await s.call('workspace_read', { cwd: second, paths: ['.'] })).isError, true);

    current = [second];
    const before = s.serverRequests.length;
    s.notify('notifications/roots/list_changed', {});
    assert.ok(await waitUntil(() => s.serverRequests.length > before));
    assert.equal((await s.call('workspace_read', { cwd: second, paths: ['.'] })).isError, false);
    assert.equal((await s.call('workspace_read', { cwd: first, paths: ['.'] })).isError, true, 'a removed root is no longer allowed');
  } finally {
    await s.close();
  }
});

test('too-broad or non-local client roots are ignored', async () => {
  const allowed = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  s.onServerRequest = (req) =>
    req.method === 'roots/list'
      ? { roots: [{ uri: uri(os.homedir()) }, { uri: uri(path.parse(allowed).root) }, { uri: 'https://example.com/repo' }] }
      : undefined;
  try {
    await s.initialize('2025-06-18', { roots: {} });
    const sub = fs.mkdtempSync(path.join(os.homedir(), 'cem-home-sub-'));
    try {
      const r = await s.call('workspace_read', { cwd: sub, paths: ['.'] });
      assert.equal(r.isError, true, 'a home-folder root does not open everything under home');
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
    const info = await s.call('codex_info', {});
    assert.match(info.text, /client roots \(allowed automatically\): \(none\)/);
    assert.match(info.text, /client roots ignored: .*too broad.*not a local folder/);
  } finally {
    await s.close();
  }
});

test('with elicitation the user is asked; "remember" persists the folder', async () => {
  const allowed = tempProject();
  const workspace = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  const approvedFile = path.join(s.logDir, 'approved-roots.json');
  s.onServerRequest = (req) => (req.method === 'elicitation/create' ? { action: 'accept', content: { remember: true } } : undefined);
  let logDir;
  try {
    await s.initialize('2025-06-18', { elicitation: {} });
    logDir = s.logDir;
    const r = await s.call('codex_run', { prompt: 'work', cwd: workspace });
    assert.equal(r.isError, false, r.text);
    const ask = s.serverRequests.find((q) => q.method === 'elicitation/create');
    assert.ok(ask, 'the client was asked');
    assert.ok(ask.params.message.includes(workspace));
    assert.equal(ask.params.requestedSchema.properties.remember.type, 'boolean');
    assert.deepEqual(JSON.parse(fs.readFileSync(approvedFile, 'utf8')).roots, [workspace]);

    const again = await s.call('workspace_read', { cwd: workspace, paths: ['.'] });
    assert.equal(again.isError, false);
    assert.equal(s.serverRequests.filter((q) => q.method === 'elicitation/create').length, 1, 'asked only once');
  } finally {
    await s.close();
  }

  // A later session (client without any capabilities) still allows it from the approved file.
  const s2 = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed, CODEX_MCP_LOG_DIR: logDir, CODEX_MCP_APPROVED_ROOTS_FILE: approvedFile });
  try {
    await s2.initialize();
    assert.equal((await s2.call('workspace_read', { cwd: workspace, paths: ['.'] })).isError, false);
    const info = await s2.call('codex_info', {});
    assert.ok(info.text.includes(`approved folders: ${workspace}`), info.text);
  } finally {
    await s2.close();
  }
});

test('a declined prompt refuses; "remember: false" allows for this session only', async () => {
  const allowed = tempProject();
  const declined = tempProject();
  const once = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  s.onServerRequest = (req) => {
    if (req.method !== 'elicitation/create') return undefined;
    return req.params.message.includes(declined) ? { action: 'decline' } : { action: 'accept', content: { remember: false } };
  };
  try {
    await s.initialize('2025-06-18', { elicitation: {} });
    const no = await s.call('codex_run', { prompt: 'work', cwd: declined });
    assert.equal(no.isError, true);
    assert.match(no.text, /did not allow Codex to work in/);

    assert.equal((await s.call('workspace_read', { cwd: once, paths: ['.'] })).isError, false);
    assert.equal(fs.existsSync(path.join(s.logDir, 'approved-roots.json')), false, 'nothing is saved without remember');
  } finally {
    await s.close();
  }
});

test('home folder and filesystem root are never offered for approval', async () => {
  const allowed = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed });
  s.onServerRequest = (req) => (req.method === 'elicitation/create' ? { action: 'accept', content: { remember: true } } : undefined);
  try {
    await s.initialize('2025-06-18', { elicitation: {} });
    for (const dir of [os.homedir(), path.parse(allowed).root]) {
      const r = await s.call('workspace_read', { cwd: dir, paths: ['.'] });
      assert.equal(r.isError, true);
      assert.match(r.text, /Refusing to run Codex/);
    }
    assert.equal(s.serverRequests.filter((q) => q.method === 'elicitation/create').length, 0);
  } finally {
    await s.close();
  }
});

test('CODEX_MCP_CLIENT_ROOTS=0 and CODEX_MCP_ASK_ROOTS=0 turn both sources off', async () => {
  const allowed = tempProject();
  const workspace = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed, CODEX_MCP_CLIENT_ROOTS: '0', CODEX_MCP_ASK_ROOTS: '0' });
  s.onServerRequest = (req) =>
    req.method === 'roots/list' ? { roots: [{ uri: uri(workspace) }] } : req.method === 'elicitation/create' ? { action: 'accept' } : undefined;
  try {
    await s.initialize('2025-06-18', { roots: {}, elicitation: {} });
    const r = await s.call('workspace_read', { cwd: workspace, paths: ['.'] });
    assert.equal(r.isError, true);
    assert.equal(s.serverRequests.length, 0, 'the client is never asked');
  } finally {
    await s.close();
  }
});

test('"allow", "allowed" and "disallow" commands manage the approved folders file', () => {
  const dir = tempProject();
  const file = path.join(tempProject(), 'approved.json');
  const run = (...args) =>
    spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', env: { ...process.env, CODEX_MCP_APPROVED_ROOTS_FILE: file } });
  let r = run('allow', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /approved: /);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).roots, [dir]);
  r = run('allowed');
  assert.ok(r.stdout.includes(dir));
  r = run('allow', os.homedir());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to approve/);
  r = run('disallow', dir);
  assert.match(r.stdout, /removed: /);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).roots, []);
});
