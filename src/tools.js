import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_MODES } from './config.js';
import { leanOverrides } from './codexConfig.js';
import { formatDuration, isWithin, oneLine, realpathOrResolve, samePath, tail, truncate } from './util.js';
import { WorkspaceError, readEntries, writeEntries } from './workspace.js';

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

/** Drop the shell wrapper Codex puts around commands (powershell -Command, bash -lc, …) for previews. */
export function shortCommand(command) {
  const s = String(command ?? '').trim();
  const m = /^"?[^"\s]*?(?:powershell|pwsh|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NoLogo\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i.exec(s);
  if (!m) return s;
  let inner = m[1].trim();
  const q = inner[0];
  if ((q === '"' || q === "'") && inner.endsWith(q) && inner.length > 1) inner = inner.slice(1, -1);
  return inner;
}

function commandLine(rec, max = 90) {
  const exit = rec.exitCode === null ? 'exit ?' : `exit ${rec.exitCode}`;
  return `#${rec.index} ${exit} $ ${oneLine(shortCommand(rec.command), max)}`;
}

function lastCommands(job, n = 3) {
  const log = job.commandLog || [];
  if (!log.length) return '';
  const lines = log.slice(-n).map((r) => `  ${commandLine(r)}`);
  const more = log.length > n ? ` (last ${n} of ${log.length})` : '';
  return `commands${more}; verbatim output via codex_output job_id "${job.id}" command N:\n${lines.join('\n')}`;
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
  const cmds = lastCommands(job);
  if (cmds) out.push(cmds);
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
    {
      name: 'codex_output',
      title: 'Verbatim command output of a Codex job',
      description:
        'Return the exact output of a command Codex ran in a job, straight from its event log; no model is involved, so nothing is paraphrased or mistyped. ' +
        'Use it to read test results or an acceptance script\'s output yourself instead of trusting Codex\'s summary. ' +
        'Without `command` or `match` it lists the job\'s commands with their numbers and exit codes. Works for finished and running jobs, and after a server restart (from the log folder).',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'job_id returned by codex_run.' },
          command: { type: 'integer', description: 'Command number from the list (1 = first). Negative counts from the end (-1 = last).' },
          match: { type: 'string', description: 'Pick the last command whose text contains this (case-insensitive), e.g. "unittest".' },
          max_chars: { type: 'integer', minimum: 200, description: `Most characters of output to return (default ${config.maxOutputChars}).` },
          head: { type: 'boolean', description: 'When output is longer than max_chars, return its beginning instead of its end (default: end, where test summaries are).' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { title: 'Verbatim command output', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ...(config.fileTools === 'off'
      ? []
      : [
          {
            name: 'workspace_read',
            title: 'Read files in a workspace',
            description:
              'Read files or list folders inside an allowed workspace directly, without Codex (no tokens, exact bytes). ' +
              'Text files are returned verbatim with their size and sha256 (plus BOM/CRLF flags); binary files report size and sha256 only; folders are listed. ' +
              'Use it to review the files Codex changed and to read result files.',
            inputSchema: {
              type: 'object',
              properties: {
                cwd: {
                  type: 'string',
                  description: 'Absolute workspace directory; same rules as codex_run.' + (config.defaultCwd ? ` Default: ${config.defaultCwd}` : ''),
                },
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 50,
                  description: 'Files or folders, relative to cwd (or absolute inside it). Use "." for the workspace itself.',
                },
                recursive: { type: 'boolean', description: 'List folders recursively (skips .git, node_modules and similar). Default false.' },
                max_chars: { type: 'integer', minimum: 200, description: `Total characters of file text to return (default ${config.maxOutputChars}).` },
              },
              required: ['paths'],
              additionalProperties: false,
            },
            annotations: { title: 'Read files in a workspace', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
        ]),
    ...(config.fileTools === 'readwrite'
      ? [
          {
            name: 'workspace_write',
            title: 'Write files in a workspace',
            description:
              'Write files inside an allowed workspace directly, byte for byte, without Codex (no tokens, no transcription errors). ' +
              'Use it to seed a project, add an acceptance script or test data before delegating. ' +
              'Existing files are kept unless overwrite is true; nothing is written if any entry is invalid. Writing inside .git is refused. Returns each file\'s size and sha256.',
            inputSchema: {
              type: 'object',
              properties: {
                cwd: {
                  type: 'string',
                  description: 'Absolute workspace directory; same rules as codex_run.' + (config.defaultCwd ? ` Default: ${config.defaultCwd}` : ''),
                },
                files: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 200,
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'File path relative to cwd. Parent folders are created.' },
                      content: { type: 'string', description: 'File content. Written exactly as given (no newline conversion).' },
                      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'utf8 (default) or base64 for binary data.' },
                      sha256: { type: 'string', description: 'Optional expected sha256 of the bytes; the call fails if it differs.' },
                    },
                    required: ['path', 'content'],
                    additionalProperties: false,
                  },
                },
                overwrite: { type: 'boolean', description: 'Replace files that already exist. Default false.' },
              },
              required: ['files'],
              additionalProperties: false,
            },
            annotations: { title: 'Write files in a workspace', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
        ]
      : []),
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

    async codex_output(args) {
      const id = str(args, 'job_id', { required: true, max: 64 });
      const found = jobs.commandsOf(id);
      if (!found) throw new ToolError(`Unknown job_id "${id}" and no log folder for it in ${config.logDir}.`);
      const { log, running, fromLog } = found;
      const note = `${running ? ' (job still running)' : ''}${fromLog ? ' (read from the log folder)' : ''}`;
      const hasIndex = args.command !== undefined && args.command !== null && args.command !== '';
      const match = str(args, 'match', { max: 500 });
      if (!hasIndex && !match) {
        if (!log.length) return { text: `Job ${id} has no finished commands yet${note}.` };
        const shown = log.slice(-100);
        const lines = shown.map((r) => `${commandLine(r, 110)} (${r.outputChars} chars)`);
        if (log.length > shown.length) lines.unshift(`… ${log.length - shown.length} earlier command(s) not shown`);
        return { text: `Commands of job ${id}${note}:\n${lines.join('\n')}` };
      }
      let rec;
      if (hasIndex) {
        const n = typeof args.command === 'number' ? args.command : Number(args.command);
        if (!Number.isInteger(n) || n === 0) throw new ToolError('"command" must be a non-zero integer');
        rec = n > 0 ? log[n - 1] : log[log.length + n];
        if (!rec) throw new ToolError(`Job ${id} has ${log.length} finished command(s); there is no command ${n}.`);
      } else {
        const needle = match.toLowerCase();
        rec = [...log].reverse().find((r) => r.command.toLowerCase().includes(needle));
        if (!rec) throw new ToolError(`No command of job ${id} contains "${match}". Call codex_output without "command" to list them.`);
      }
      const max = num(args, 'max_chars', config.maxOutputChars, 200, 2_000_000);
      const head = args.head === true;
      const outText = rec.output;
      let body = outText;
      let cut = '';
      if (outText.length > max) {
        body = head ? truncate(outText, max) : tail(outText, max);
        cut = ` | showing ${head ? 'first' : 'last'} ${max} chars`;
      }
      const lost = rec.truncated ? ' | older output was not kept (see events.jsonl in the log folder)' : '';
      return {
        text: [
          `#${rec.index} $ ${rec.command}`,
          `exit: ${rec.exitCode === null ? '?' : rec.exitCode} | status: ${rec.status || '?'} | ${rec.outputChars} chars${cut}${lost}${note}`,
          '--- output ---',
          body,
        ].join('\n'),
      };
    },

    async workspace_read(args) {
      if (config.fileTools === 'off') throw new ToolError('workspace_read is turned off (CODEX_MCP_FILE_TOOLS=off).');
      const cwd = resolveCwd(str(args, 'cwd', { max: 4096 }), config);
      const paths = args.paths;
      if (!Array.isArray(paths) || !paths.length || paths.length > 50 || !paths.every((p) => typeof p === 'string' && p.length <= 4096)) {
        throw new ToolError('"paths" must be a list of 1 to 50 path strings');
      }
      const maxChars = num(args, 'max_chars', config.maxOutputChars, 200, 2_000_000);
      return { text: readEntries(cwd, paths, { maxChars, recursive: args.recursive === true }) };
    },

    async workspace_write(args) {
      if (config.fileTools !== 'readwrite') {
        throw new ToolError('workspace_write is turned off. The user can enable it with CODEX_MCP_FILE_TOOLS=readwrite (it is on by default when CODEX_MCP_ALLOWED_ROOTS is set).');
      }
      const cwd = resolveCwd(str(args, 'cwd', { max: 4096 }), config);
      const files = args.files;
      if (!Array.isArray(files) || !files.length || files.length > 200) throw new ToolError('"files" must be a list of 1 to 200 entries');
      try {
        return { text: `Wrote ${files.length} file(s) in ${cwd}:\n${writeEntries(cwd, files, { overwrite: args.overwrite === true })}` };
      } catch (err) {
        if (err instanceof WorkspaceError) throw new ToolError(err.message);
        throw new ToolError(`write failed: ${err.message}`);
      }
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
      lines.push(
        `file tools: ${config.fileTools}` +
          { off: ' (workspace_read and workspace_write disabled)', read: ' (workspace_read only; set CODEX_MCP_FILE_TOOLS=readwrite to allow workspace_write)', readwrite: ' (workspace_read + workspace_write inside allowed folders)' }[config.fileTools],
      );
      lines.push(`change tracking: ${config.snapshotMaxFiles ? `workspace snapshot (up to ${config.snapshotMaxFiles} files) + Codex edits` : 'Codex edits only'}`);
      lines.push(`logs: ${config.logDir}`);
      return { text: lines.join('\n') };
    },
  };

  return { definitions, handlers };
}
