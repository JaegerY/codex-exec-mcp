import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

test('legacy initialize echoes a supported version and lists tools', async () => {
  const s = startServer();
  try {
    const init = await s.initialize('2025-06-18');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'codex-exec-mcp');
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /codex_status/);
    assert.equal(init.result.resultType, undefined, 'legacy results carry no resultType');

    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['codex_cancel', 'codex_info', 'codex_run', 'codex_status']);
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 20);
    }
    assert.equal((await s.request('ping', {})).result && true, true);
  } finally {
    await s.close();
  }
});

test('legacy initialize with an unknown version falls back to the newest legacy version', async () => {
  const s = startServer();
  try {
    const init = await s.initialize('2099-01-01');
    assert.equal(init.result.protocolVersion, '2025-11-25');
  } finally {
    await s.close();
  }
});

test('modern server/discover and stateless tools/list', async () => {
  const s = startServer();
  try {
    const d = await s.request('server/discover', { _meta: MODERN_META });
    assert.equal(d.result.resultType, 'complete');
    assert.ok(d.result.supportedVersions.includes('2026-07-28'));
    assert.ok(d.result.supportedVersions.includes('2025-11-25'));
    assert.equal(typeof d.result.ttlMs, 'number');
    assert.equal(d.result.cacheScope, 'public');
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'codex-exec-mcp');

    // No initialize needed in the modern era.
    const list = await s.request('tools/list', { _meta: MODERN_META });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.tools.length, 4);
    assert.equal(typeof list.result.ttlMs, 'number');

    const info = await s.request('tools/call', { _meta: MODERN_META, name: 'codex_info', arguments: {} });
    assert.equal(info.result.resultType, 'complete');
    assert.match(info.result.content[0].text, /codex version: 0\.163\.0/);
  } finally {
    await s.close();
  }
});

test('modern request with an unsupported version gets -32022 with the supported list', async () => {
  const s = startServer();
  try {
    const res = await s.request('tools/list', { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
    assert.equal(res.error.code, -32022);
    assert.equal(res.error.data.requested, '1900-01-01');
    assert.ok(res.error.data.supported.includes('2026-07-28'));
  } finally {
    await s.close();
  }
});

test('errors: parse error, unknown method, unknown tool, invalid request', async () => {
  const s = startServer();
  try {
    await s.initialize();
    s.sendRaw('{not json}\n');
    const unknown = await s.request('does/not/exist', {});
    assert.equal(unknown.error.code, -32601);
    const parseErr = s.notifications.find((m) => m.error && m.error.code === -32700);
    assert.ok(parseErr, 'parse error reported with id null');
    assert.equal(parseErr.id, null);

    const badTool = await s.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(badTool.error.code, -32602);

    s.sendRaw(`${JSON.stringify({ id: 99, method: 'ping' })}\n`); // missing jsonrpc
    const ping = await s.request('ping', {});
    assert.ok(ping.result);
    assert.ok(s.notifications.some((m) => m.id === 99 && m.error && m.error.code === -32600));
  } finally {
    await s.close();
  }
});

test('stdout only ever contains JSON-RPC messages and CRLF input works', async () => {
  const s = startServer();
  try {
    s.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 'crlf', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })}\r\n`);
    await new Promise((r) => setTimeout(r, 300));
    await s.call('codex_info');
    for (const line of s.rawLines) {
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, '2.0');
    }
    assert.ok(s.rawLines.some((l) => JSON.parse(l).id === 'crlf'));
  } finally {
    await s.close();
  }
});

test('server exits when stdin closes', async () => {
  const s = startServer();
  await s.initialize();
  const code = await s.close();
  assert.equal(code, 0);
});
