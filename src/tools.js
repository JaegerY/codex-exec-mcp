import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_MODES } from './config.js';
import { leanOverrides } from './codexConfig.js';
import { formatDuration, isWithin, oneLine, realpathOrResolve, samePath, truncate } from './util.js';

/** A tool failure that should be reported to the model (isError result), not as a protocol error. */
export class ToolError extends Error {}

const KIND_LETTER = { add: 'A', delete: 'D', update: 'M' };

/** Show workspace files relative to cwd (shorter for the model), others absolute. */
function displayPath(p, cwd) {
  if (cwd && path.isAbsolute(p) && isWithin(p, cwd)) {
    const rel = path.relative(cwd, p);
    return rel ? rel.split(path.sep).join('/') : p;
  }
  return p;
}

function describeFiles(files, cwd, limit = 50) {
  const entries = [...files.entries()].map(([p, kind]) => [displayPath(p, cwd), kind]);
  const lines = entries.slice(0, limit).map(([p, kind]) => `  ${KIND_LETTER[kind] || '?'} ${p}${KIND_LETTER[kind] ? '' : ` (${kind})`}`);
  if (entries.length > limit) lines.push(`  … and ${entries.length - limit} more`);
  return lines.join('\n');
}

function statsLine(job) {
  const parts = [`duration: ${formatDuration(job.elapsedMs())}`];
  parts.push(`commands: ${job.commands}${job.commandsFailed ? ` (${job.commandsFailed} failed)` : ''}`);
  parts.push(`files changed: ${job.files.size}`);
  if (job.usage) {
    const u = job.usage;
    parts.push(`codex tokens: in ${u.input_tokens ?? '?'}${u.cached_input_tokens ? ` (cached ${u.cached_input_tokens})` : ''} / out ${u.output_tokens ?? '?'}`);
  }
  return parts.join(' | ');
}

/** Text returned to the model for a finished job. Kept compact on purpose. */
export function formatFinished(job, config) {
  const out = [];
  const msg = job.finalMessage || '';
  if (msg) {
    out.push(truncate(msg, config.maxOutputChars));
    if (msg.length > config.maxOutputChars) {
      out.push(`\n[truncated: ${msg.length} chars total; full text in ${path.join(job.logDir || '', 'last_message.txt')}]`);
    }
  } else {
    out.push('(Codex produced no final message)');
  }
  out.push('\n---');
  out.push(`status: ${job.state} | job_id: ${job.id}${job.sessionId ? ` | session_id: ${job.sessionId}` : ''}`);
  out.push(statsLine(job));
  if (job.files.size) out.push(`files:\n${describeFiles(job.files, job.cwd)}`);
  if (job.snapshotSkipped) out.push('note: workspace too large to snapshot; files changed by shell commands may be missing from this list.');
  if (job.state !== 'completed') {
    if (job.error) out.push(`error: ${job.error}`);
    const stderr = job.stderrTail.trim();
    if (stderr) out.push(`codex stderr (last lines):\n${stderr.slice(-1500)}`);
    if (job.logDir) out.push(`logs: ${job.logDir}`);
  }
  if (job.sessionId && job.state === 'completed') {
    out.push(`To continue this Codex conversation, call codex_run with session_id "${job.sessionId}".`);
  }
  return out.join('\n');
}

export function formatRunning(job, waitSec) {
  return [
    `status: running | job_id: ${job.id} | elapsed: ${formatDuration(job.elapsedMs())}`,
    `latest: ${job.lastActivity}`,
    `progress: ${job.commands} commands${job.commandsFailed ? ` (${job.commandsFailed} failed)` : ''}, ${job.files.size} files changed`,
    `Codex is still working. Call codex_status with job_id "${job.id}" to wait for the result (each call waits up to ${waitSec}s), or codex_cancel to stop it.`,
  ].join('\n');
}

function progressMessage(job) {
  return `Codex ${formatDuration(job.elapsedMs())}: ${job.lastActivity} [${job.commands} cmds, ${job.files.size} files]`;
}

function str(args, key, { required = false, max = 1_000_000 } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`"${key}" is required`);
    return '';
  }
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  if (v.length > max) throw new ToolError(`"${key}" is too long (${v.length} > ${max} chars)`);
  return v;
}

function num(args, key, def, min, max) {
  const v = args[key];
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`"${key}" must be a number`);
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Validate the working directory against the configured guard rails. */
function resolveCwd(requested, config) {
  const raw = requested || config.defaultCwd || process.cwd();
  if (!path.isAbsolute(raw)) throw new ToolError(`cwd must be an absolute path, got "${raw}"`);
  let stat;
  try {
    stat = fs.statSync(raw);
  } catch {
    throw new ToolError(`cwd does not exist: ${raw}`);
  }
  if (!stat.isDirectory()) throw new ToolError(`cwd is not a directory: ${raw}`);
  const real = realpathOrResolve(raw);
  const roots = config.allowedRoots.map(realpathOrResolve);
  if (roots.length) {
    if (!roots.some((r) => isWithin(real, r))) {
      throw new ToolError(`cwd "${real}" is outside CODEX_MCP_ALLOWED_ROOTS (${roots.join(path.delimiter)})`);
    }
    return real;
  }
  // Without an allow-list, refuse locations that are almost certainly too broad.
  if ([path.parse(real).root, os.homedir()].some((p) => samePath(real, realpathOrResolve(p)))) {
    throw new ToolError(`Refusing to run Codex in "${real}" (filesystem root or home directory). Use a project directory, or set CODEX_MCP_ALLOWED_ROOTS.`);
  }
  if (process.platform === 'win32' && process.env.SystemRoot && isWithin(real, process.env.SystemRoot)) {
    throw new ToolError(`Refusing to run Codex inside ${process.env.SystemRoot}. Pass a project directory as cwd.`);
  }
  return real;
}

function resolveSandbox(requested, config) {
  const sandbox = requested || config.defaultSandbox;
  if (!SANDBOX_MODES.includes(sandbox)) throw new ToolError(`sandbox must be one of: ${SANDBOX_MODES.join(', ')}`);
  if (sandbox === 'danger-full-access' && !config.allowDanger) {
    throw new ToolError('sandbox "danger-full-access" is disabled. The user can enable it by setting CODEX_MCP_ALLOW_DANGER=1 for this MCP server.');
  }
  return sandbox;
}

export function createTools({ config, codex, jobs, serverVersion }) {
  const definitions = [
    {
      name: 'codex_run',
      title: 'Run a task with Codex',
      description:
        'Delegate a self-contained task to the Codex CLI (`codex exec`), which works as an autonomous coding sub-agent in `cwd` using the user\'s own Codex configuration and model provider. ' +
        'Codex can read and edit files and run commands, limited by `sandbox`. ' +
        'Write `prompt` as a complete brief: the goal, relevant files, constraints, how to verify the work, and ask it to end with a short summary of what it did (its final message is returned to you). ' +
        'Returns the final message plus a summary of changed files and commands. ' +
        'If Codex is not done within `wait_sec`, returns status "running" and a job_id: call codex_status to get the result. ' +
        'Pass `session_id` from an earlier result to continue the same Codex conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Complete task brief for Codex.' },
          cwd: {
            type: 'string',
            description: 'Absolute path of the project directory Codex works in.' + (config.defaultCwd ? ` Default: ${config.defaultCwd}` : ''),
          },
          sandbox: {
            type: 'string',
            enum: config.allowDanger ? SANDBOX_MODES : SANDBOX_MODES.filter((m) => m !== 'danger-full-access'),
            description: `read-only: inspect only. workspace-write: may edit files inside cwd. Default: ${config.defaultSandbox}.`,
          },
          session_id: { type: 'string', description: 'Continue an earlier Codex session (session_id from a previous result).' },
          model: { type: 'string', description: 'Override the model from the user\'s Codex config. Usually omit.' },
          wait_sec: {
            type: 'integer',
            minimum: 0,
            maximum: 3600,
            description: `Seconds to wait for completion before returning a job_id (default ${config.runWaitSec}). Use 0 to start in the background.`,
          },
          timeout_sec: {
            type: 'integer',
            minimum: 10,
            description: `Hard time limit for the whole Codex run; it is stopped after this (default ${config.timeoutSec}).`,
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      annotations: { title: 'Run a task with Codex', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'codex_status',
      title: 'Check a Codex job',
      description:
        'Wait for a Codex job started by codex_run and return its result when it finishes (or its progress if still running after `wait_sec`). Omit job_id to list recent jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'job_id returned by codex_run.' },
          wait_sec: {
            type: 'integer',
            minimum: 0,
            maximum: 3600,
            description: `Seconds to wait for the job to finish before returning progress (default ${config.statusWaitSec}).`,
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Check a Codex job', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'codex_cancel',
      title: 'Cancel a Codex job',
      description: 'Stop a running Codex job and everything it started. Changes Codex already made to files are kept.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'job_id returned by codex_run.' } },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { title: 'Cancel a Codex job', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'codex_info',
      title: 'Codex setup info',
      description:
        'Show which Codex CLI is used, its version and detected features, and this server\'s settings (default cwd, sandbox, limits). Costs no model tokens; use it to diagnose setup problems.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Codex setup info', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];

  const tick = (ctx) => (job) => ctx.progress(progressMessage(job));

  const handlers = {
    async codex_run(args, ctx) {
      const prompt = str(args, 'prompt', { required: true });
      if (!prompt.trim()) throw new ToolError('"prompt" must not be empty');
      const cwd = resolveCwd(str(args, 'cwd', { max: 4096 }), config);
      const sandbox = resolveSandbox(str(args, 'sandbox', { max: 64 }), config);
      const sessionId = str(args, 'session_id', { max: 256 });
      if (sessionId && !/^[\w.:-]+$/.test(sessionId)) throw new ToolError('"session_id" contains invalid characters');
      const model = str(args, 'model', { max: 200 }) || config.defaultModel;
      if (model && !/^[\w.:/@+-]+$/.test(model)) throw new ToolError('"model" contains invalid characters');
      const waitSec = num(args, 'wait_sec', config.runWaitSec, 0, 3600);
      const timeoutSec = num(args, 'timeout_sec', config.timeoutSec, 10, 7 * 24 * 3600);

      let job;
      try {
        job = await jobs.start({ prompt, cwd, sandbox, model, sessionId, timeoutSec });
      } catch (err) {
        throw new ToolError(err.message);
      }
      // If the client cancels this request while we are waiting, stop Codex too.
      const onAbort = () => jobs.cancel(job);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const finished = await jobs.waitFor(job, waitSec * 1000, { signal: ctx.signal, onTick: tick(ctx), tickMs: config.progressIntervalMs });
        if (!finished) return { text: formatRunning(job, config.statusWaitSec) };
        return { text: formatFinished(job, config), isError: job.state !== 'completed' };
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },

    async codex_status(args, ctx) {
      const id = str(args, 'job_id', { max: 64 });
      if (!id) {
        const list = jobs.list();
        if (!list.length) return { text: 'No Codex jobs in this session.' };
        return {
          text: list
            .slice(0, 20)
            .map((j) => `${j.id} | ${j.state} | ${formatDuration(j.elapsedMs())} | ${j.cwd} | ${oneLine(j.promptPreview, 80)}`)
            .join('\n'),
        };
      }
      const job = jobs.get(id);
      if (!job) throw new ToolError(`Unknown job_id "${id}". It may have expired, or the MCP server was restarted.`);
      const waitSec = num(args, 'wait_sec', config.statusWaitSec, 0, 3600);
      const finished = await jobs.waitFor(job, waitSec * 1000, { signal: ctx.signal, onTick: tick(ctx), tickMs: config.progressIntervalMs });
      if (!finished) return { text: formatRunning(job, config.statusWaitSec) };
      return { text: formatFinished(job, config), isError: job.state !== 'completed' };
    },

    async codex_cancel(args) {
      const id = str(args, 'job_id', { required: true, max: 64 });
      const job = jobs.get(id);
      if (!job) throw new ToolError(`Unknown job_id "${id}"`);
      if (job.finished) return { text: `Job ${id} already finished with status ${job.state}.` };
      jobs.cancel(job);
      await jobs.waitFor(job, 8000);
      return {
        text: job.finished
          ? `Cancelled job ${id}. ${job.files.size} file(s) had been changed before it stopped.${job.files.size ? `\n${describeFiles(job.files, job.cwd)}` : ''}`
          : `Cancel requested for job ${id}; it is still shutting down.`,
      };
    },

    async codex_info() {
      const lines = [`codex-exec-mcp ${serverVersion} (node ${process.version}, ${process.platform}/${process.arch})`];
      try {
        const { launcher, features } = await codex.detect({ force: true });
        lines.push(`codex: ${launcher.path} [found via ${launcher.source}]`);
        lines.push(`codex version: ${features.version}`);
        const flags = Object.entries(features)
          .filter(([k, v]) => typeof v === 'boolean')
          .map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`)
          .join(', ');
        lines.push(`detected features: ${flags}`);
        if (!features.json) lines.push('warning: this Codex has no --json output; progress and change summaries are unavailable. Consider upgrading Codex.');
        if (!features.resume) lines.push('warning: this Codex cannot resume sessions (no "exec resume").');
      } catch (err) {
        lines.push(`codex: NOT AVAILABLE — ${err.message}`);
      }
      lines.push(`default cwd: ${config.defaultCwd || `(server working directory: ${process.cwd()})`}`);
      lines.push(`allowed roots: ${config.allowedRoots.length ? config.allowedRoots.join(path.delimiter) : '(any, except filesystem root / home directory)'}`);
      lines.push(`default sandbox: ${config.defaultSandbox}${config.allowDanger ? ' (danger-full-access allowed)' : ''}`);
      if (process.platform === 'win32') {
        lines.push(
          config.windowsSandbox
            ? `windows sandbox: ${config.windowsSandbox} (passed as -c windows.sandbox)`
            : 'windows sandbox: from your Codex config. Note: on native Windows Codex only enforces the sandbox if `[windows] sandbox` is set in ~/.codex/config.toml; otherwise set CODEX_MCP_WINDOWS_SANDBOX=unelevated.',
        );
      }
      if (config.defaultModel) lines.push(`default model: ${config.defaultModel}`);
      if (config.extraArgs.length) lines.push(`extra codex args: ${JSON.stringify(config.extraArgs)}`);
      lines.push(`limits: wait ${config.runWaitSec}s per call, timeout ${config.timeoutSec}s per job, ${config.maxConcurrent} concurrent jobs, ${config.maxOutputChars} output chars`);
      lines.push(`jobs: ${jobs.running().length} running, ${jobs.list().length} tracked`);
      if (config.lean) {
        const lean = leanOverrides({ keep: config.leanKeep });
        lines.push(
          `lean mode: on — plugins off, ${lean.disabled.length} MCP server(s) from your Codex config disabled for sub-agent runs` +
            (lean.disabled.length ? ` (${lean.disabled.join(', ')})` : '') +
            (lean.kept.length ? `; kept: ${lean.kept.join(', ')}` : ''),
        );
        if (lean.skipped.length) lines.push(`warning: cannot disable MCP server(s) with "." in the name: ${lean.skipped.join(', ')}`);
        if (!lean.sources.length) lines.push('note: no Codex config.toml found; only plugins are turned off.');
      } else {
        lines.push('lean mode: off (set CODEX_MCP_LEAN=1 to turn off plugins and your Codex MCP servers for sub-agent runs and save tokens)');
      }
      lines.push(`change tracking: ${config.snapshotMaxFiles ? `workspace snapshot (up to ${config.snapshotMaxFiles} files) + Codex edits` : 'Codex edits only'}`);
      lines.push(`logs: ${config.logDir}`);
      return { text: lines.join('\n') };
    },
  };

  return { definitions, handlers };
}
