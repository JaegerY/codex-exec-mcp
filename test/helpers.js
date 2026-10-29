import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(here, '..', 'cli', 'codex-exec-mcp.js');
export const FAKE_CODEX = path.join(here, 'fixtures', 'fake-codex.mjs');

export function tempProject() {
  // .native expands Windows 8.3 short names (C:\\Users\\RUNNER~1), like the server does.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cem-proj-')));
}

/** Start the server with the fake Codex and return a tiny JSON-RPC client. */
export function startServer(env = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cem-logs-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CODEX_MCP_CODEX_PATH: FAKE_CODEX,
      CODEX_MCP_LOG_DIR: logDir,
      CODEX_MCP_APPROVED_ROOTS_FILE: path.join(logDir, 'approved-roots.json'),
      CODEX_MCP_PROGRESS_INTERVAL_MS: '200',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  const rawLines = [];
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      rawLines.push(line);
      const msg = JSON.parse(line); // throws if the server ever writes non-JSON to stdout
      if (typeof msg.method === 'string' && 'id' in msg) {
        // A request from the server (roots/list, elicitation/create).
        client.serverRequests.push(msg);
        Promise.resolve(client.onServerRequest ? client.onServerRequest(msg) : undefined).then((result) => {
          const reply = result === undefined
            ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
            : { jsonrpc: '2.0', id: msg.id, result };
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        });
        continue;
      }
      if ('id' in msg && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        notifications.push(msg);
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  const client = {
    child,
    logDir,
    notifications,
    rawLines,
    serverRequests: [],
    onServerRequest: null,
    get stderr() {
      return stderr;
    },
    exited,
    sendRaw(text) {
      child.stdin.write(text);
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params, { id = nextId++, timeoutMs = 20000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method} (id ${id})\nstderr:\n${stderr}`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async initialize(protocolVersion = '2025-06-18', capabilities = {}) {
      const res = await client.request('initialize', { protocolVersion, capabilities, clientInfo: { name: 'test', version: '1' } });
      client.notify('notifications/initialized', {});
      return res;
    },
    async call(name, args = {}, extraParams = {}) {
      const res = await client.request('tools/call', { name, arguments: args, ...extraParams }, { timeoutMs: 30000 });
      if (res.error) throw new Error(`RPC error: ${JSON.stringify(res.error)}`);
      return { text: res.result.content.map((c) => c.text).join('\n'), isError: res.result.isError, raw: res };
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
  return client;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(fn, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
