import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExecArgs, killTree, spawnCodex } from './codex.js';
import { leanOverrides } from './codexConfig.js';
import { diffSnapshots, takeSnapshot } from './snapshot.js';
import { newJobId, oneLine, tail } from './util.js';

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const STDERR_KEEP = 8000;
const STDOUT_KEEP = 20000;
const MAX_JOBS_IN_MEMORY = 100;
const FINISHED_JOB_TTL_MS = 6 * 60 * 60 * 1000;

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function safeWrite(file, data) {
  try {
    fs.writeFileSync(file, data);
  } catch {
    /* logging must never break a job */
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Delete per-job log directories older than `days`. */
function pruneLogs(logDir, days) {
  if (!days) return;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('j_')) continue;
    const p = path.join(logDir, e.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export class Job extends EventEmitter {
  constructor(init) {
    super();
    this.setMaxListeners(50);
    Object.assign(this, {
      id: newJobId(),
      state: 'running',
      createdAt: Date.now(),
      endedAt: null,
      sessionId: init.resumeSessionId || null,
      exitCode: null,
      signal: null,
      error: null,
      finalMessage: '',
      lastAgentMessage: '',
      stdoutTail: '',
      stderrTail: '',
      lastActivity: 'starting codex',
      commands: 0,
      commandsFailed: 0,
      files: new Map(),
      usage: null,
      cancelRequested: false,
      timedOut: false,
      child: null,
      logDir: null,
      ...init,
    });
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  get finished() {
    return FINISHED.has(this.state);
  }

  elapsedMs() {
    return (this.endedAt || Date.now()) - this.createdAt;
  }

  touch(activity) {
    if (activity) this.lastActivity = activity;
    this.emit('update');
  }
}

/**
 * Starts `codex exec` processes and tracks them as jobs. The tool layer never
 * touches child processes directly.
 */
export class JobManager {
  constructor(config, codex) {
    this.config = config;
    this.codex = codex;
    this.jobs = new Map();
    safeMkdir(config.logDir);
    pruneLogs(config.logDir, config.logRetentionDays);
  }

  running() {
    return [...this.jobs.values()].filter((j) => !j.finished);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  gc() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finished && now - job.endedAt > FINISHED_JOB_TTL_MS) this.jobs.delete(id);
    }
    if (this.jobs.size > MAX_JOBS_IN_MEMORY) {
      const finished = this.list().filter((j) => j.finished).reverse();
      while (this.jobs.size > MAX_JOBS_IN_MEMORY && finished.length) this.jobs.delete(finished.shift().id);
    }
  }

  /**
   * Start a job. Resolves once the process is spawned (not when it finishes).
   * opts: { prompt, cwd, sandbox, model, sessionId, timeoutSec }
   */
  async start(opts) {
    this.gc();
    if (this.running().length >= this.config.maxConcurrent) {
      throw new Error(
        `Too many Codex jobs running (${this.config.maxConcurrent} max). Wait for one to finish or cancel it with codex_cancel.`,
      );
    }
    const { launcher, features } = await this.codex.detect();
    const job = new Job({
      cwd: opts.cwd,
      sandbox: opts.sandbox,
      model: opts.model || '',
      resumeSessionId: opts.sessionId || null,
      promptPreview: oneLine(opts.prompt, 160),
      codexVersion: features.version,
      timeoutSec: opts.timeoutSec,
    });

    let logDir = path.join(this.config.logDir, job.id);
    if (!safeMkdir(logDir)) {
      logDir = path.join(os.tmpdir(), `codex-exec-mcp-${job.id}`);
      safeMkdir(logDir);
    }
    job.logDir = logDir;
    const lastMessageFile = path.join(logDir, 'last_message.txt');
    safeWrite(path.join(logDir, 'prompt.txt'), opts.prompt);

    const lean = this.config.lean ? leanOverrides({ keep: this.config.leanKeep }) : null;
    job.lean = lean;
    // Snapshot before Codex starts, to catch files changed by shell commands.
    job.snapshotBefore = takeSnapshot(opts.cwd, this.config.snapshotMaxFiles);
    job.snapshotSkipped = this.config.snapshotMaxFiles > 0 && !job.snapshotBefore;

    const args = buildExecArgs(features, {
      lastMessageFile,
      cwd: opts.cwd,
      sandbox: opts.sandbox,
      skipGitRepoCheck: this.config.skipGitRepoCheck,
      model: opts.model,
      extraArgs: this.config.extraArgs,
      leanArgs: lean ? lean.args : [],
      windowsSandbox: process.platform === 'win32' ? this.config.windowsSandbox : '',
      sessionId: opts.sessionId,
    });
    safeWrite(path.join(logDir, 'command.json'), JSON.stringify({ launcher, args, cwd: opts.cwd }, null, 2));

    let eventsStream = null;
    try {
      eventsStream = fs.createWriteStream(path.join(logDir, 'events.jsonl'));
      eventsStream.on('error', () => {
        eventsStream = null;
      });
    } catch {
      eventsStream = null;
    }

    let child;
    try {
      child = spawnCodex(launcher, args, { cwd: opts.cwd });
    } catch (err) {
      job.error = `Failed to start Codex: ${err.message}`;
      this._finish(job, { lastMessageFile, eventsStream });
      this.jobs.set(job.id, job);
      return job;
    }
    job.child = child;
    this.jobs.set(job.id, job);

    child.stdin.on('error', () => {});
    child.stdin.end(opts.prompt, 'utf8');

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (eventsStream) eventsStream.write(chunk);
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        this._onLine(job, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      job.stderrTail = tail(job.stderrTail + chunk, STDERR_KEEP);
    });

    const timer = setTimeout(() => {
      job.timedOut = true;
      job.touch(`timed out after ${opts.timeoutSec}s, stopping codex`);
      killTree(child);
    }, opts.timeoutSec * 1000);

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      if (buffer.trim()) this._onLine(job, buffer);
      buffer = '';
      this._finish(job, { lastMessageFile, eventsStream });
    };

    child.on('error', (err) => {
      job.error = job.error || `Failed to run Codex: ${err.message}`;
      finalize();
    });
    child.on('exit', (code, signal) => {
      job.exitCode = code;
      job.signal = signal;
      // A background process started by Codex can keep stdout open after
      // Codex itself exited; do not wait for it forever.
      setTimeout(() => {
        if (!finalized) {
          child.stdout.destroy();
          child.stderr.destroy();
          finalize();
        }
      }, 2000).unref();
    });
    child.on('close', (code, signal) => {
      if (job.exitCode === null) job.exitCode = code;
      if (job.signal === null) job.signal = signal;
      finalize();
    });

    return job;
  }

  _onLine(job, line) {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      job.stdoutTail = tail(`${job.stdoutTail}${line}\n`, STDOUT_KEEP);
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    try {
      this._onEvent(job, ev);
    } catch {
      /* an unexpected event shape must not break the job */
    }
  }

  _onEvent(job, ev) {
    const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) job.sessionId = ev.thread_id;
        job.touch('session started');
        return;
      case 'turn.started':
        job.touch('working');
        return;
      case 'turn.completed':
        if (ev.usage) job.usage = ev.usage;
        job.touch('turn completed');
        return;
      case 'turn.failed':
        job.error = (ev.error && ev.error.message) || 'turn failed';
        job.touch(`error: ${oneLine(job.error, 100)}`);
        return;
      case 'error':
        job.error = ev.message || 'error';
        job.touch(`error: ${oneLine(job.error, 100)}`);
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (item) this._onItem(job, ev.type, item);
        return;
      default:
        break;
    }
    // Older `codex exec --json` output: {"id":..,"msg":{"type":..}}
    const msg = ev.msg && typeof ev.msg === 'object' ? ev.msg : null;
    if (msg) {
      if (msg.type === 'session_configured' && msg.session_id) job.sessionId = msg.session_id;
      if (msg.type === 'agent_message' && typeof msg.message === 'string') job.lastAgentMessage = msg.message;
      if (msg.type === 'exec_command_begin' && msg.command) job.touch(`$ ${oneLine([].concat(msg.command).join(' '), 100)}`);
      if (msg.type === 'error' && msg.message) job.error = msg.message;
    }
  }

  _onItem(job, phase, item) {
    const done = phase === 'item.completed';
    switch (item.type) {
      case 'command_execution':
        if (!done) {
          job.touch(`$ ${oneLine(item.command, 100)}`);
        } else {
          job.commands += 1;
          const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
          if (failed) job.commandsFailed += 1;
          job.touch(`$ ${oneLine(item.command, 80)} → ${failed ? `exit ${item.exit_code ?? '?'}` : 'ok'}`);
        }
        return;
      case 'file_change':
        if (done && Array.isArray(item.changes)) {
          for (const c of item.changes) {
            if (c && c.path) {
              const key = path.resolve(job.cwd || '.', String(c.path));
              job.files.set(key, item.status === 'failed' ? `${c.kind || 'update'} (failed)` : c.kind || 'update');
            }
          }
          job.touch(`edited ${item.changes.map((c) => path.basename(String(c.path))).join(', ')}`);
        }
        return;
      case 'agent_message':
        if (done && typeof item.text === 'string') {
          job.lastAgentMessage = item.text;
          job.touch(`message: ${oneLine(item.text, 80)}`);
        }
        return;
      case 'reasoning':
        if (typeof item.text === 'string') job.touch(`thinking: ${oneLine(item.text, 80)}`);
        return;
      case 'mcp_tool_call':
        job.touch(`tool: ${item.server || ''}${item.tool ? `.${item.tool}` : ''}`);
        return;
      case 'web_search':
        job.touch(`web search: ${oneLine(item.query || '', 80)}`);
        return;
      case 'todo_list':
        if (Array.isArray(item.items)) {
          const total = item.items.length;
          const completed = item.items.filter((t) => t && t.completed).length;
          job.touch(`plan ${completed}/${total}`);
        }
        return;
      case 'error':
        if (item.message) job.touch(`warning: ${oneLine(item.message, 100)}`);
        return;
      default:
        job.touch();
    }
  }

  _finish(job, { lastMessageFile, eventsStream }) {
    if (job.finished) return;
    if (eventsStream) eventsStream.end();
    const fromFile = safeRead(lastMessageFile);
    job.finalMessage = (fromFile && fromFile.trim()) ? fromFile : job.lastAgentMessage || job.stdoutTail.trim();
    if (job.snapshotBefore) {
      const after = takeSnapshot(job.cwd, this.config.snapshotMaxFiles);
      if (after) {
        // The snapshot is the ground truth for files inside the workspace.
        for (const [p, kind] of diffSnapshots(job.snapshotBefore, after)) job.files.set(p, kind);
      } else {
        job.snapshotSkipped = true;
      }
      job.snapshotBefore = null;
    }
    job.endedAt = Date.now();
    job.child = null;
    if (job.cancelRequested) job.state = 'cancelled';
    else if (job.timedOut) job.state = 'timed_out';
    else if (job.exitCode === 0 && !job.error) job.state = 'completed';
    else job.state = 'failed';
    if (job.state === 'failed' && !job.error) {
      job.error = job.exitCode === null ? `codex was terminated (${job.signal || 'unknown signal'})` : `codex exited with code ${job.exitCode}`;
    }
    job.lastActivity = job.state;
    if (job.logDir) {
      safeWrite(
        path.join(job.logDir, 'summary.json'),
        JSON.stringify(
          {
            id: job.id,
            state: job.state,
            sessionId: job.sessionId,
            cwd: job.cwd,
            sandbox: job.sandbox,
            exitCode: job.exitCode,
            error: job.error,
            durationMs: job.elapsedMs(),
            commands: job.commands,
            commandsFailed: job.commandsFailed,
            files: Object.fromEntries(job.files),
            usage: job.usage,
          },
          null,
          2,
        ),
      );
      safeWrite(path.join(job.logDir, 'stderr.log'), job.stderrTail);
    }
    job.emit('update');
    job._resolveDone(job);
  }

  cancel(job) {
    if (job.finished) return false;
    job.cancelRequested = true;
    job.touch('cancelling');
    killTree(job.child);
    return true;
  }

  cancelAll() {
    for (const job of this.running()) this.cancel(job);
  }

  /**
   * Wait until the job finishes, `ms` elapses or `signal` aborts.
   * `onTick` is called every `tickMs` while waiting (used for progress).
   */
  waitFor(job, ms, { signal, onTick, tickMs } = {}) {
    if (job.finished || ms <= 0) return Promise.resolve(job.finished);
    return new Promise((resolve) => {
      let tick = null;
      const cleanup = (value) => {
        clearTimeout(timer);
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => cleanup(job.finished);
      const timer = setTimeout(() => cleanup(job.finished), ms);
      job.done.then(() => cleanup(true));
      if (signal) {
        if (signal.aborted) return cleanup(job.finished);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (onTick && tickMs) tick = setInterval(() => onTick(job), tickMs);
    });
  }
}
