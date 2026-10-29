import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin, realpathOrResolve, samePath } from './util.js';

/**
 * Decides which folders Codex may work in.
 *
 * The allow-list exists to limit what the model can reach, so a folder is
 * only ever added from the user's side, never from a tool argument:
 *  1. CODEX_MCP_ALLOWED_ROOTS (static, set by the user)
 *  2. the client's MCP roots (the folders the user opened or connected in the
 *     client), when the client supports `roots`
 *  3. folders the user approved earlier (approved-roots file)
 *  4. a confirmation prompt shown by the client (MCP elicitation), when the
 *     client supports it; "remember" stores the folder in the approved file
 * The filesystem root, the home folder and the Windows system folder are never
 * added automatically.
 */

export class AccessError extends Error {}

const ROOTS_TIMEOUT_MS = 5000;
const ELICIT_TIMEOUT_MS = 10 * 60 * 1000;

/** True for folders that are far too broad to hand to an autonomous agent. */
export function isTooBroad(dir) {
  const real = realpathOrResolve(dir);
  const candidates = [path.parse(real).root, os.homedir()];
  if (process.platform === 'win32' && process.env.SystemRoot) candidates.push(process.env.SystemRoot);
  for (const c of candidates) if (samePath(real, realpathOrResolve(c))) return true;
  if (process.platform === 'win32' && process.env.SystemRoot && isWithin(real, process.env.SystemRoot)) return true;
  return false;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Convert an MCP root (file:// URI) to a real directory path, or null. */
export function rootToPath(root) {
  const uri = root && typeof root === 'object' ? root.uri : root;
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    const p = fileURLToPath(uri);
    return isDirectory(p) ? realpathOrResolve(p) : null;
  } catch {
    return null;
  }
}

export class WorkspaceAccess {
  constructor(config, { log } = {}) {
    this.config = config;
    this.log = log || (() => {});
    this.client = null; // { request(method, params, opts), capabilities, info }
    this.clientRoots = null; // null = not loaded yet
    this.ignoredRoots = [];
    this.loading = null;
    this.sessionApproved = [];
  }

  /** Called by the protocol layer once the client is initialized. */
  attach(client) {
    this.client = client;
    this.clientRoots = null;
    this.loading = null;
    if (this.supportsRoots()) this.refreshRoots().catch(() => {});
  }

  supportsRoots() {
    return Boolean(this.config.clientRoots && this.client && this.client.capabilities && this.client.capabilities.roots);
  }

  supportsElicitation() {
    return Boolean(this.config.askRoots && this.client && this.client.capabilities && this.client.capabilities.elicitation);
  }

  /** Re-read the client's roots (after notifications/roots/list_changed). */
  rootsChanged() {
    this.clientRoots = null;
    this.loading = null;
    if (this.supportsRoots()) this.refreshRoots().catch(() => {});
  }

  async refreshRoots() {
    if (!this.supportsRoots()) {
      this.clientRoots = [];
      return this.clientRoots;
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await this.client.request('roots/list', {}, { timeoutMs: ROOTS_TIMEOUT_MS });
        const list = Array.isArray(res && res.roots) ? res.roots : [];
        const kept = [];
        const ignored = [];
        for (const r of list) {
          const p = rootToPath(r);
          if (!p) ignored.push(`${r && r.uri ? r.uri : String(r)} (not a local folder)`);
          else if (isTooBroad(p)) ignored.push(`${p} (too broad)`);
          else if (!kept.some((k) => samePath(k, p))) kept.push(p);
        }
        this.clientRoots = kept;
        this.ignoredRoots = ignored;
        this.log(`client roots: ${kept.length ? kept.join(path.delimiter) : '(none)'}${ignored.length ? `; ignored: ${ignored.join(', ')}` : ''}`);
      } catch (err) {
        this.log(`roots/list failed: ${err.message}`);
        this.clientRoots = [];
      } finally {
        this.loading = null;
      }
      return this.clientRoots;
    })();
    return this.loading;
  }

  async getClientRoots() {
    if (!this.supportsRoots()) return [];
    if (this.clientRoots) return this.clientRoots;
    return this.refreshRoots();
  }

  readApproved() {
    const file = this.config.approvedRootsFile;
    if (!file) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(data) ? data : Array.isArray(data && data.roots) ? data.roots : [];
      return list.filter((p) => typeof p === 'string' && path.isAbsolute(p) && isDirectory(p) && !isTooBroad(p)).map(realpathOrResolve);
    } catch {
      return [];
    }
  }

  remember(dir) {
    const file = this.config.approvedRootsFile;
    if (!file) return false;
    try {
      let roots = [];
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        roots = Array.isArray(data && data.roots) ? data.roots.filter((p) => typeof p === 'string') : [];
      } catch {
        /* new file */
      }
      if (!roots.some((p) => samePath(p, dir))) roots.push(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ roots }, null, 2)}\n`);
      return true;
    } catch (err) {
      this.log(`could not save approved folder: ${err.message}`);
      return false;
    }
  }

  /** Ask the user through the client. Resolves to the root to allow, or null. */
  async ask(dir, signal) {
    let res;
    try {
      res = await this.client.request(
        'elicitation/create',
        {
          message:
            `Codex (codex-exec-mcp) is asked to work in:\n${dir}\n\n` +
            'This folder is not in its allowed folders. Allow Codex to read, edit and run commands there?',
          requestedSchema: {
            type: 'object',
            properties: {
              remember: {
                type: 'boolean',
                title: 'Remember this folder',
                description: 'Also allow it in future sessions (saved in the approved folders file).',
                default: true,
              },
            },
          },
        },
        { timeoutMs: ELICIT_TIMEOUT_MS, signal },
      );
    } catch (err) {
      this.log(`elicitation failed: ${err.message}`);
      return null;
    }
    if (!res || res.action !== 'accept') return null;
    const remember = !res.content || res.content.remember !== false;
    if (remember) this.remember(dir);
    this.sessionApproved.push(dir);
    return dir;
  }

  /**
   * Validate a requested working directory. Returns its real path or throws
   * AccessError with a message that says how to allow it.
   */
  async resolveCwd(requested, { signal } = {}) {
    const config = this.config;
    const raw = requested || config.defaultCwd || process.cwd();
    if (!path.isAbsolute(raw)) throw new AccessError(`cwd must be an absolute path, got "${raw}"`);
    let stat;
    try {
      stat = fs.statSync(raw);
    } catch {
      throw new AccessError(`cwd does not exist: ${raw}`);
    }
    if (!stat.isDirectory()) throw new AccessError(`cwd is not a directory: ${raw}`);
    const real = realpathOrResolve(raw);
    const staticRoots = config.allowedRoots.map(realpathOrResolve);

    if (!staticRoots.length) {
      // Without an allow-list, refuse only locations that are almost certainly too broad.
      if (isTooBroad(real)) {
        throw new AccessError(`Refusing to run Codex in "${real}" (filesystem root, home directory or system folder). Use a project directory, or set CODEX_MCP_ALLOWED_ROOTS.`);
      }
      return real;
    }
    if (staticRoots.some((r) => isWithin(real, r))) return real;

    const clientRoots = await this.getClientRoots();
    if (clientRoots.some((r) => isWithin(real, r))) return real;
    if (this.sessionApproved.some((r) => isWithin(real, r))) return real;
    if (this.readApproved().some((r) => isWithin(real, r))) return real;

    if (isTooBroad(real)) {
      throw new AccessError(`Refusing to run Codex in "${real}" (filesystem root, home directory or system folder). Use a project directory.`);
    }
    if (this.supportsElicitation()) {
      const ok = await this.ask(real, signal);
      if (ok) return real;
      throw new AccessError(`The user did not allow Codex to work in "${real}".`);
    }
    throw new AccessError(
      `cwd "${real}" is outside CODEX_MCP_ALLOWED_ROOTS (${staticRoots.join(path.delimiter)}) and not an approved folder. ` +
        'It is allowed automatically when it is one of the folders open in the client (MCP roots) or after the user approves it; ' +
        `this client (${this.describeClient()}) offers neither. The user can add it to CODEX_MCP_ALLOWED_ROOTS, ` +
        `or to the approved folders file ${config.approvedRootsFile || '(disabled)'}, or run: codex-exec-mcp allow "${real}"`,
    );
  }

  describeClient() {
    if (!this.client) return 'no client connected';
    const caps = this.client.capabilities || {};
    const name = this.client.info ? `${this.client.info.name || '?'} ${this.client.info.version || ''}`.trim() : 'unknown client';
    return `${name}; roots: ${caps.roots ? 'yes' : 'no'}, elicitation: ${caps.elicitation ? 'yes' : 'no'}`;
  }

  /** Lines for codex_info. */
  async describe() {
    const lines = [];
    const c = this.config;
    lines.push(`allowed roots: ${c.allowedRoots.length ? c.allowedRoots.join(path.delimiter) : '(any, except filesystem root / home / system folder)'}`);
    lines.push(`client: ${this.describeClient()}`);
    if (c.allowedRoots.length) {
      if (!c.clientRoots) lines.push('client roots: off (CODEX_MCP_CLIENT_ROOTS=0)');
      else if (this.supportsRoots()) {
        const roots = await this.getClientRoots();
        lines.push(`client roots (allowed automatically): ${roots.length ? roots.join(path.delimiter) : '(none)'}`);
        if (this.ignoredRoots.length) lines.push(`client roots ignored: ${this.ignoredRoots.join(', ')}`);
      } else lines.push('client roots: not offered by this client');
      lines.push(`ask before other folders: ${!c.askRoots ? 'off (CODEX_MCP_ASK_ROOTS=0)' : this.supportsElicitation() ? 'yes (client prompt)' : 'not offered by this client'}`);
      const approved = this.readApproved();
      lines.push(`approved folders: ${approved.length ? approved.join(path.delimiter) : '(none)'}${c.approvedRootsFile ? ` [${c.approvedRootsFile}]` : ''}`);
    }
    return lines;
  }
}

/** `codex-exec-mcp allow DIR` / `disallow DIR` / `allowed`: manage the approved folders file. */
export function manageApproved(argv, config, log) {
  const [cmd, ...rest] = argv;
  const access = new WorkspaceAccess(config);
  const file = config.approvedRootsFile;
  if (!file) throw new Error('the approved folders file is disabled (CODEX_MCP_APPROVED_ROOTS_FILE=off)');
  if (cmd === 'allowed') {
    const list = access.readApproved();
    log(list.length ? list.join('\n') : '(no approved folders)');
    log(`file: ${file}`);
    return 0;
  }
  if (!rest.length) throw new Error(`usage: codex-exec-mcp ${cmd} DIR [DIR...]`);
  for (const d of rest) {
    const dir = path.resolve(d);
    if (cmd === 'allow') {
      if (!isDirectory(dir)) throw new Error(`not a directory: ${dir}`);
      const real = realpathOrResolve(dir);
      if (isTooBroad(real)) throw new Error(`refusing to approve ${real} (filesystem root, home directory or system folder)`);
      access.remember(real);
      log(`approved: ${real}`);
    } else {
      let roots = [];
      try {
        roots = JSON.parse(fs.readFileSync(file, 'utf8')).roots || [];
      } catch {
        /* nothing to remove */
      }
      const left = roots.filter((p) => !samePath(p, dir));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ roots: left }, null, 2)}\n`);
      log(left.length < roots.length ? `removed: ${dir}` : `not in the list: ${dir}`);
    }
  }
  log(`file: ${file}`);
  return 0;
}
