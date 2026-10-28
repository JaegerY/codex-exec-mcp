import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leanOverrides, mcpServerNames } from '../src/codexConfig.js';
import { startServer, tempProject } from './helpers.js';

const SAMPLE_CONFIG = `
model = "deepseek-v4-pro"
model_provider = "deepseek"

[mcp_servers.node_repl]
command = 'C:\\tools\\node_repl.exe'

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\me\\.codex'

[mcp_servers.dm-mcp-service-bill]
url = "https://example.com/bill/"

[mcp_servers.dm-mcp-service-bill.http_headers]
x-app-key = "secret"

[mcp_servers."quoted-name"] # comment
command = "x"

[mcp_servers.'dot.name']
command = "y"

[mcp_servers]
inline_one = { command = "z" }
"inline-two" = { url = "https://example.com" }

[plugins."browser@openai-bundled"]
enabled = true

[model_providers.deepseek]
name = "deepseek"
`;

test('mcpServerNames finds top-level server tables and inline entries only', () => {
  assert.deepEqual(mcpServerNames(SAMPLE_CONFIG).sort(), ['dm-mcp-service-bill', 'dot.name', 'inline-two', 'inline_one', 'node_repl', 'quoted-name'].sort());
  assert.deepEqual(mcpServerNames(''), []);
  assert.deepEqual(mcpServerNames('[mcp_servers_extra.foo]\n[x.mcp_servers.bar]'), []);
});

function codexHomeWith(text) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cem-home-'));
  if (text !== null) fs.writeFileSync(path.join(home, 'config.toml'), text);
  return home;
}

test('leanOverrides disables plugins and every addressable server, honours keep', () => {
  const env = { CODEX_HOME: codexHomeWith(SAMPLE_CONFIG) };
  const r = leanOverrides({ keep: ['inline_one'], env });
  assert.deepEqual(r.args.slice(0, 2), ['-c', 'features.plugins=false']);
  assert.ok(r.args.includes('mcp_servers.node_repl.enabled=false'));
  assert.ok(r.args.includes('mcp_servers.dm-mcp-service-bill.enabled=false'));
  assert.ok(r.args.includes('mcp_servers.quoted-name.enabled=false'));
  assert.ok(r.args.includes('mcp_servers.inline-two.enabled=false'));
  assert.ok(!r.args.some((a) => a.includes('inline_one')), 'kept server stays enabled');
  assert.ok(!r.args.some((a) => a.includes('dot.name')), 'unaddressable name is skipped');
  assert.deepEqual(r.skipped, ['dot.name']);
  assert.ok(!r.args.some((a) => /\.env\.|http_headers/.test(a)), 'sub-tables are not servers');

  const none = leanOverrides({ env: { CODEX_HOME: codexHomeWith(null) } });
  assert.deepEqual(none.args, ['-c', 'features.plugins=false']);
  assert.deepEqual(none.sources, []);
});

test('lean mode passes the overrides to codex exec and codex_info explains them', async () => {
  const home = codexHomeWith(SAMPLE_CONFIG);
  const s = startServer({ CODEX_HOME: home, CODEX_MCP_LEAN: '1', CODEX_MCP_LEAN_KEEP: 'node_repl' });
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[echoargs]', cwd });
    const { argv } = JSON.parse(r.text.split('\n---')[0]);
    const overrides = argv.filter((a, i) => argv[i - 1] === '-c');
    assert.ok(overrides.includes('features.plugins=false'));
    assert.ok(overrides.includes('mcp_servers.dm-mcp-service-bill.enabled=false'));
    assert.ok(!overrides.includes('mcp_servers.node_repl.enabled=false'));
    assert.ok(argv.indexOf('features.plugins=false') < argv.indexOf('-'), 'overrides come before the prompt marker');

    const info = await s.call('codex_info');
    assert.match(info.text, /lean mode: on — plugins off, 4 MCP server\(s\)/);
    assert.match(info.text, /kept: node_repl/);
    assert.match(info.text, /cannot disable MCP server\(s\) with "\." in the name: dot\.name/);
  } finally {
    await s.close();
  }
});

test('without CODEX_MCP_LEAN nothing is disabled', async () => {
  const s = startServer({ CODEX_HOME: codexHomeWith(SAMPLE_CONFIG) });
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[echoargs]', cwd });
    const { argv } = JSON.parse(r.text.split('\n---')[0]);
    assert.ok(!argv.includes('features.plugins=false'));
    assert.ok(!argv.some((a) => a.startsWith('mcp_servers.')));
    assert.match((await s.call('codex_info')).text, /lean mode: off/);
  } finally {
    await s.close();
  }
});

test('files created or deleted by shell commands appear in the summary', async () => {
  const s = startServer();
  const cwd = tempProject();
  fs.writeFileSync(path.join(cwd, 'gone.txt'), 'old');
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'same');
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[touch:made.txt] [touch:sub/dir/deep.txt] [rm:gone.txt] [touch:node_modules/pkg/index.js]', cwd });
    assert.match(r.text, / A made\.txt/);
    assert.match(r.text, / A sub\/dir\/deep\.txt/);
    assert.match(r.text, / D gone\.txt/);
    assert.doesNotMatch(r.text, /keep\.txt/, 'untouched files are not listed');
    assert.doesNotMatch(r.text, /node_modules/, 'heavy directories are skipped');
    assert.match(r.text, /files changed: 3/);
  } finally {
    await s.close();
  }
});

test('Codex patch edits and shell edits are merged; the snapshot decides the kind', async () => {
  const s = startServer();
  const cwd = tempProject();
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'b.js'), 'existing');
  try {
    await s.initialize();
    // fake reports src/a.js (update) and src/b.js (add) via file_change, but only touches b.js on disk
    const r = await s.call('codex_run', { prompt: '[files] [touch:src/b.js]', cwd });
    assert.match(r.text, / M src\/a\.js/, 'patch edit outside the snapshot is kept');
    assert.match(r.text, / M src\/b\.js/, 'existing file is reported as modified, not added');
  } finally {
    await s.close();
  }
});

test('snapshot can be disabled or skipped for large workspaces', async () => {
  const cwd = tempProject();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(cwd, `f${i}.txt`), String(i));

  const off = startServer({ CODEX_MCP_SNAPSHOT_MAX_FILES: '0' });
  try {
    await off.initialize();
    const r = await off.call('codex_run', { prompt: '[touch:x1.txt]', cwd });
    assert.doesNotMatch(r.text, /x1\.txt/);
    assert.doesNotMatch(r.text, /too large/);
  } finally {
    await off.close();
  }

  const small = startServer({ CODEX_MCP_SNAPSHOT_MAX_FILES: '2' });
  try {
    await small.initialize();
    const r = await small.call('codex_run', { prompt: '[touch:x2.txt]', cwd });
    assert.match(r.text, /workspace too large to snapshot/);
  } finally {
    await small.close();
  }
});
