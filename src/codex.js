import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Locating and launching the Codex CLI.
 *
 * Everything that depends on the Codex CLI's command-line surface lives in
 * this file. Features are detected from `codex exec --help` at runtime, so a
 * Codex release that adds, renames or drops a flag degrades gracefully instead
 * of breaking the server.
 */

const isJsFile = (p) => /\.(c|m)?js$/i.test(p);
const isCmdShim = (p) => /\.(cmd|bat)$/i.test(p);

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** npm's Windows shim `codex.cmd` sits next to node_modules/@openai/codex. */
function jsEntryNextToShim(shimPath) {
  const dir = path.dirname(shimPath);
  const candidates = [
    path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  return candidates.find(fileExists) || '';
}

function launcherFor(file, source) {
  if (isJsFile(file)) {
    return { command: process.execPath, prefixArgs: [file], shell: false, path: file, source };
  }
  if (process.platform === 'win32' && isCmdShim(file)) {
    const js = jsEntryNextToShim(file);
    if (js) {
      // Run the JS entry with node directly: no cmd.exe, no quoting problems.
      return { command: process.execPath, prefixArgs: [js], shell: false, path: js, source: `${source} (via ${path.basename(file)})` };
    }
    return { command: file, prefixArgs: [], shell: true, path: file, source };
  }
  return { command: file, prefixArgs: [], shell: false, path: file, source };
}

function searchDirs(env) {
  const fromPath = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const extra =
    process.platform === 'win32'
      ? [env.APPDATA && path.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'codex')]
      : [
          // GUI apps (e.g. Claude Desktop on macOS) start with a minimal PATH.
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global', 'bin'),
          path.join(home, '.volta', 'bin'),
          path.join(home, '.bun', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
        ];
  return [...new Set([...fromPath, ...extra.filter(Boolean)])];
}

/**
 * Find how to launch Codex. Order: CODEX_MCP_CODEX_PATH, then PATH and a few
 * common install locations.
 */
export function resolveCodex(config, env = process.env) {
  if (config.codexPath) {
    const p = path.resolve(config.codexPath);
    if (!fileExists(p)) {
      throw new Error(`CODEX_MCP_CODEX_PATH points to "${p}", which does not exist`);
    }
    return launcherFor(p, 'CODEX_MCP_CODEX_PATH');
  }
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex.bat'] : ['codex'];
  for (const dir of searchDirs(env)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return launcherFor(candidate, 'PATH');
    }
  }
  throw new Error(
    'Could not find the Codex CLI. Install it with "npm i -g @openai/codex", or set CODEX_MCP_CODEX_PATH to the full path of codex (codex.cmd / codex.exe on Windows).',
  );
}

function quoteForCmd(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Spawn options shared by every Codex invocation. */
function spawnArgs(launcher, args, opts = {}) {
  const fullArgs = [...launcher.prefixArgs, ...args];
  const base = {
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // On POSIX, a new process group lets us kill Codex and everything it spawned.
    detached: process.platform !== 'win32',
  };
  if (launcher.shell) {
    // Only reached for .cmd/.bat shims we could not unwrap. Arguments are ours
    // (flags, paths, model names); the prompt always travels over stdin.
    const line = [quoteForCmd(launcher.command), ...fullArgs.map(quoteForCmd)].join(' ');
    return { file: line, args: [], options: { ...base, shell: true } };
  }
  return { file: launcher.command, args: fullArgs, options: base };
}

export function spawnCodex(launcher, args, opts) {
  const { file, args: a, options } = spawnArgs(launcher, args, opts);
  return spawn(file, a, options);
}

/** Run a short Codex command (e.g. --help) and collect its output. */
export function runCodexCapture(launcher, args, { timeoutMs = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCodex(launcher, args, { cwd: cwd || os.tmpdir() });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err && err.message ? err.message : err), error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', (err) => finish({ code: null, stdout, stderr: `${stderr}${err.message}`, error: err }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** Kill a process and all of its descendants. Safe to call more than once. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 3000);
  timer.unref();
}

const has = (help, re) => re.test(help);

/** Parse `codex --version` and `codex exec --help` into a feature map. */
export function parseFeatures(versionText, helpText) {
  const help = helpText || '';
  const versionMatch = /(\d+\.\d+\.\d+[\w.-]*)/.exec(versionText || '');
  return {
    version: versionMatch ? versionMatch[1] : 'unknown',
    json: has(help, /--json\b/) || has(help, /--experimental-json\b/),
    jsonFlag: has(help, /--json\b/) ? '--json' : '--experimental-json',
    outputLastMessage: has(help, /--output-last-message\b/),
    cd: has(help, /--cd\b/),
    sandbox: has(help, /--sandbox\b/),
    skipGitRepoCheck: has(help, /--skip-git-repo-check\b/),
    model: has(help, /--model\b/),
    color: has(help, /--color\b/),
    resume: has(help, /^\s+resume\b/m),
  };
}

/**
 * Cached feature detection. Re-detected after `ttlMs` so a Codex upgrade is
 * picked up without restarting the MCP server.
 */
export class CodexCli {
  constructor(config, { ttlMs = 10 * 60 * 1000 } = {}) {
    this.config = config;
    this.ttlMs = ttlMs;
    this.cached = null;
    this.pending = null;
  }

  async detect({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const launcher = resolveCodex(this.config);
      const [ver, help] = await Promise.all([
        runCodexCapture(launcher, ['--version']),
        runCodexCapture(launcher, ['exec', '--help']),
      ]);
      if (help.code !== 0 || !/exec/i.test(help.stdout + help.stderr)) {
        const detail = (help.stderr || help.stdout || '').trim().slice(-800);
        throw new Error(`"codex exec --help" failed (exit ${help.code}). Is this a working Codex CLI?\n${detail}`);
      }
      const features = parseFeatures(ver.stdout || ver.stderr, help.stdout);
      this.cached = { at: Date.now(), launcher, features };
      return this.cached;
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
}

/** Build the argv for one `codex exec` run. The prompt is read from stdin. */
export function buildExecArgs(features, opts) {
  const args = ['exec'];
  if (features.json) args.push(features.jsonFlag);
  if (features.color && !features.json) args.push('--color', 'never');
  if (features.outputLastMessage && opts.lastMessageFile) args.push('--output-last-message', opts.lastMessageFile);
  if (features.cd && opts.cwd) args.push('--cd', opts.cwd);
  if (features.sandbox && opts.sandbox) args.push('--sandbox', opts.sandbox);
  if (features.skipGitRepoCheck && opts.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (opts.model) {
    if (!features.model) throw new Error('This Codex version does not support --model');
    args.push('--model', opts.model);
  }
  // Lean mode: plugins and the user's MCP servers off for this run only.
  if (opts.leanArgs && opts.leanArgs.length) args.push(...opts.leanArgs);
  // On native Windows, Codex only enforces --sandbox when `[windows] sandbox` is set.
  if (opts.windowsSandbox) args.push('-c', `windows.sandbox="${opts.windowsSandbox}"`);
  if (opts.extraArgs && opts.extraArgs.length) args.push(...opts.extraArgs);
  if (opts.sessionId) {
    if (!features.resume) throw new Error(`Codex ${features.version} does not support "codex exec resume"; cannot continue a session`);
    args.push('resume', opts.sessionId, '-');
  } else {
    args.push('-');
  }
  return args;
}
