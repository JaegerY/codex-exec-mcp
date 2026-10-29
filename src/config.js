import os from 'node:os';
import path from 'node:path';
import { isTruthy } from './util.js';

/** Modes of CODEX_MCP_FILE_TOOLS (workspace_read / workspace_write). */
export const FILE_TOOL_MODES = ['off', 'read', 'readwrite'];

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
/** Values of Codex's `[windows] sandbox` setting. */
export const WINDOWS_SANDBOX_MODES = ['unelevated', 'elevated', 'mxc'];

function intFrom(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return Math.min(Math.max(n, min), max);
}

function listFrom(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

function jsonArrayFrom(env, name) {
  const raw = env[name];
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["-c","model_reasoning_effort=high"]`);
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

/** Where folders the user approved are remembered; "off" disables the file. */
function approvedRootsFile(env) {
  const raw = (env.CODEX_MCP_APPROVED_ROOTS_FILE || '').trim();
  if (/^(off|0|none)$/i.test(raw)) return '';
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), '.codex-exec-mcp', 'approved-roots.json');
}

/**
 * All configuration comes from environment variables so it can be set in any
 * MCP client's "env" block without depending on command-line quoting.
 */
export function loadConfig(env = process.env) {
  const defaultSandbox = env.CODEX_MCP_DEFAULT_SANDBOX || 'workspace-write';
  if (!SANDBOX_MODES.includes(defaultSandbox)) {
    throw new Error(`CODEX_MCP_DEFAULT_SANDBOX must be one of ${SANDBOX_MODES.join(', ')}`);
  }
  const allowDanger = isTruthy(env.CODEX_MCP_ALLOW_DANGER);
  if (defaultSandbox === 'danger-full-access' && !allowDanger) {
    throw new Error('CODEX_MCP_DEFAULT_SANDBOX=danger-full-access also requires CODEX_MCP_ALLOW_DANGER=1');
  }
  const windowsSandbox = env.CODEX_MCP_WINDOWS_SANDBOX || '';
  if (windowsSandbox && !WINDOWS_SANDBOX_MODES.includes(windowsSandbox)) {
    throw new Error(`CODEX_MCP_WINDOWS_SANDBOX must be one of ${WINDOWS_SANDBOX_MODES.join(', ')}`);
  }
  const allowedRoots = listFrom(env, 'CODEX_MCP_ALLOWED_ROOTS');
  // Writing files directly is on by default only when the folders are fenced in.
  const fileTools = (env.CODEX_MCP_FILE_TOOLS || (allowedRoots.length ? 'readwrite' : 'read')).trim().toLowerCase();
  if (!FILE_TOOL_MODES.includes(fileTools)) {
    throw new Error(`CODEX_MCP_FILE_TOOLS must be one of ${FILE_TOOL_MODES.join(', ')}`);
  }
  return {
    codexPath: env.CODEX_MCP_CODEX_PATH || '',
    windowsSandbox,
    lean: isTruthy(env.CODEX_MCP_LEAN),
    leanKeep: (env.CODEX_MCP_LEAN_KEEP || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    snapshotMaxFiles: intFrom(env, 'CODEX_MCP_SNAPSHOT_MAX_FILES', 20000, 0, 1_000_000),
    defaultCwd: env.CODEX_MCP_DEFAULT_CWD || '',
    allowedRoots,
    fileTools,
    clientRoots: env.CODEX_MCP_CLIENT_ROOTS !== '0',
    askRoots: env.CODEX_MCP_ASK_ROOTS !== '0',
    approvedRootsFile: approvedRootsFile(env),
    defaultSandbox,
    allowDanger,
    defaultModel: env.CODEX_MCP_DEFAULT_MODEL || '',
    extraArgs: jsonArrayFrom(env, 'CODEX_MCP_EXTRA_ARGS'),
    skipGitRepoCheck: env.CODEX_MCP_SKIP_GIT_REPO_CHECK !== '0',
    runWaitSec: intFrom(env, 'CODEX_MCP_RUN_WAIT_SEC', 45, 0, 3600),
    statusWaitSec: intFrom(env, 'CODEX_MCP_STATUS_WAIT_SEC', 45, 0, 3600),
    timeoutSec: intFrom(env, 'CODEX_MCP_TIMEOUT_SEC', 1800, 10, 7 * 24 * 3600),
    maxConcurrent: intFrom(env, 'CODEX_MCP_MAX_CONCURRENT', 4, 1, 64),
    maxOutputChars: intFrom(env, 'CODEX_MCP_MAX_OUTPUT_CHARS', 20000, 500, 2_000_000),
    logDir: env.CODEX_MCP_LOG_DIR || path.join(os.tmpdir(), 'codex-exec-mcp'),
    logRetentionDays: intFrom(env, 'CODEX_MCP_LOG_RETENTION_DAYS', 7, 0, 3650),
    progressIntervalMs: intFrom(env, 'CODEX_MCP_PROGRESS_INTERVAL_MS', 10000, 200, 600000),
  };
}
