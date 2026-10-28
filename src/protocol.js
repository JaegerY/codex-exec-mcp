import { ToolError } from './tools.js';

/**
 * A small, dependency-free MCP server over stdio.
 *
 * It is "dual-era" as defined by the 2026-07-28 specification:
 *  - Modern clients send `io.modelcontextprotocol/protocolVersion` in every
 *    request's `_meta` and may probe with `server/discover`.
 *  - Legacy clients (2025-11-25 and earlier) open with `initialize`.
 * Both are served by the same process.
 */

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNSUPPORTED_VERSION: -32022,
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class McpServer {
  /**
   * @param {object} opts
   * @param {{name:string, version:string, title?:string}} opts.serverInfo
   * @param {string} opts.instructions
   * @param {{definitions:object[], handlers:Record<string, Function>}} opts.tools
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({ serverInfo, instructions, tools, log }) {
    this.serverInfo = serverInfo;
    this.instructions = instructions;
    this.tools = tools;
    this.log = log || ((m) => process.stderr.write(`[codex-exec-mcp] ${m}\n`));
    this.legacyVersion = null;
    this.inflight = new Map(); // request id -> AbortController
    this.output = null;
    this.closed = false;
  }

  /** Attach to streams. Resolves when the input stream ends. */
  serve(input, output) {
    this.output = output;
    output.on('error', (err) => {
      this.log(`stdout error: ${err.message}`);
      this.closed = true;
    });
    let buffer = '';
    input.setEncoding('utf8');
    return new Promise((resolve) => {
      input.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.trim()) this.handleLine(line);
        }
      });
      const end = () => {
        if (buffer.trim()) this.handleLine(buffer);
        buffer = '';
        resolve();
      };
      input.on('end', end);
      input.on('close', end);
    });
  }

  send(message) {
    if (this.closed || !this.output) return;
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.log(`failed to write message: ${err.message}`);
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batches existed only in 2025-03-26; answer each element.
      for (const m of msg) this.handleMessage(m);
      return;
    }
    this.handleMessage(msg);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      if (msg && typeof msg === 'object' && 'id' in msg) {
        this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: ERR.INVALID_REQUEST, message: 'Invalid request' } });
      }
      return;
    }
    if (typeof msg.method !== 'string') return; // a response; we never send requests
    const isRequest = 'id' in msg && msg.id !== null && msg.id !== undefined;
    if (!isRequest) {
      this.handleNotification(msg);
      return;
    }
    this.handleRequest(msg).catch((err) => this.log(`unhandled error in ${msg.method}: ${err && err.stack ? err.stack : err}`));
  }

  handleNotification(msg) {
    if (msg.method === 'notifications/cancelled') {
      const id = msg.params && msg.params.requestId;
      const ctl = this.inflight.get(id);
      if (ctl) {
        this.log(`request ${id} cancelled by client`);
        ctl.abort();
      }
    }
    // notifications/initialized and others need no action.
  }

  /** Decide which protocol era/version a request uses. */
  eraOf(params) {
    const meta = params && typeof params === 'object' ? params._meta : null;
    const requested = meta && typeof meta === 'object' ? meta[META_VERSION] : undefined;
    if (typeof requested === 'string') {
      if (!MODERN_VERSIONS.includes(requested)) {
        throw new RpcError(ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: ALL_VERSIONS, requested });
      }
      return { modern: true, version: requested };
    }
    return { modern: false, version: this.legacyVersion || LEGACY_VERSIONS[0] };
  }

  async handleRequest(msg) {
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const ctl = new AbortController();
    this.inflight.set(id, ctl);
    let era = { modern: false, version: this.legacyVersion || LEGACY_VERSIONS[0] };
    try {
      era = this.eraOf(params);
      const result = await this.dispatch(method, params, era, id, ctl.signal);
      if (ctl.signal.aborted) return; // MUST NOT answer a cancelled request
      this.send({ jsonrpc: '2.0', id, result: this.decorate(result, era) });
    } catch (err) {
      if (ctl.signal.aborted) return;
      const rpc = err instanceof RpcError ? err : new RpcError(ERR.INTERNAL, err && err.message ? err.message : String(err));
      const error = { code: rpc.code, message: rpc.message };
      if (rpc.data !== undefined) error.data = rpc.data;
      this.send({ jsonrpc: '2.0', id, error });
    } finally {
      this.inflight.delete(id);
    }
  }

  decorate(result, era) {
    if (!era.modern) return result;
    return { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER_INFO]: this.serverInfo } };
  }

  capabilities() {
    return { tools: { listChanged: false } };
  }

  async dispatch(method, params, era, id, signal) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        this.legacyVersion = version;
        const client = params.clientInfo ? `${params.clientInfo.name} ${params.clientInfo.version || ''}`.trim() : 'unknown client';
        this.log(`initialize from ${client}, protocol ${requested} -> ${version}`);
        return {
          protocolVersion: version,
          capabilities: this.capabilities(),
          serverInfo: this.serverInfo,
          instructions: this.instructions,
        };
      }
      case 'server/discover':
        return {
          supportedVersions: ALL_VERSIONS,
          capabilities: this.capabilities(),
          instructions: this.instructions,
          ttlMs: 3600000,
          cacheScope: 'public',
        };
      case 'ping':
        return {};
      case 'logging/setLevel':
        return {};
      case 'tools/list': {
        // `title` and `annotations` are ignored by older clients, so one shape fits all versions.
        const result = { tools: this.tools.definitions };
        if (era.modern) Object.assign(result, { ttlMs: 3600000, cacheScope: 'public' });
        return result;
      }
      case 'tools/call':
        return this.callTool(params, id, signal);
      case 'resources/list':
        return era.modern ? { resources: [], ttlMs: 3600000, cacheScope: 'public' } : { resources: [] };
      case 'resources/templates/list':
        return era.modern ? { resourceTemplates: [], ttlMs: 3600000, cacheScope: 'public' } : { resourceTemplates: [] };
      case 'prompts/list':
        return era.modern ? { prompts: [], ttlMs: 3600000, cacheScope: 'public' } : { prompts: [] };
      default:
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async callTool(params, id, signal) {
    const name = params.name;
    const handler = typeof name === 'string' && Object.prototype.hasOwnProperty.call(this.tools.handlers, name) ? this.tools.handlers[name] : null;
    if (!handler) throw new RpcError(ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const progressToken = params._meta ? params._meta.progressToken : undefined;
    let progressCount = 0;
    const ctx = {
      signal,
      progress: (message) => {
        if (progressToken === undefined || progressToken === null || signal.aborted) return;
        progressCount += 1;
        this.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: progressCount, message } });
      },
    };
    try {
      const out = await handler(args, ctx);
      return { content: [{ type: 'text', text: out.text }], isError: Boolean(out.isError) };
    } catch (err) {
      if (err instanceof ToolError) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
      this.log(`tool ${name} crashed: ${err && err.stack ? err.stack : err}`);
      return { content: [{ type: 'text', text: `Internal error in ${name}: ${err && err.message ? err.message : err}` }], isError: true };
    }
  }
}
