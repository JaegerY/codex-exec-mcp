import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIRS } from './snapshot.js';
import { isWithin, realpathOrResolve } from './util.js';

/**
 * Direct file access inside a validated workspace, without a model in the
 * loop. Lets the client seed a project or an acceptance script byte-for-byte
 * and read results back exactly, instead of asking Codex to transcribe them.
 */

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_DEPTH = 6;

export class WorkspaceError extends Error {}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Workspace-relative path with forward slashes, for display. */
function rel(p, base) {
  const r = path.relative(base, p);
  return r ? r.split(path.sep).join('/') : '.';
}

/**
 * Resolve `p` against `base` and make sure the result, with symlinks and
 * junctions followed, stays inside `base` (which must already be a real path).
 */
export function resolveInside(p, base) {
  if (typeof p !== 'string' || !p.trim()) throw new WorkspaceError('empty path');
  if (p.includes('\0')) throw new WorkspaceError(`invalid path "${p}"`);
  const full = path.resolve(base, p);
  // Follow links on the deepest part of the path that exists.
  const missing = [];
  let probe = full;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  const real = path.join(realpathOrResolve(probe), ...missing);
  if (!isWithin(real, base)) throw new WorkspaceError(`"${p}" is outside the workspace ${base}`);
  return real;
}

function decodeText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function describeText(buf, text) {
  const tags = ['utf-8'];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) tags.push('BOM');
  if (text.includes('\r\n')) tags.push('CRLF');
  return tags.join(', ');
}

function listDir(dir, base, recursive) {
  const lines = [];
  let truncated = false;
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      lines.push(`  ! ${rel(d, base)}: ${err.code || err.message}`);
      return;
    }
    for (const e of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const skipped = SKIP_DIRS.has(e.name);
        lines.push(`  d ${rel(full, base)}/${skipped ? ' (not listed)' : ''}`);
        if (recursive && !skipped && depth < MAX_LIST_DEPTH) walk(full, depth + 1);
      } else {
        let size = '?';
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        lines.push(`  f ${rel(full, base)} (${size} bytes)`);
      }
    }
  };
  walk(dir, 1);
  if (truncated) lines.push(`  … stopped after ${MAX_LIST_ENTRIES} entries`);
  return lines;
}

/**
 * Read files and directories inside `base`. Text files come back verbatim
 * with size and sha256; binary files report size and sha256 only.
 * `maxChars` bounds the total text returned.
 */
export function readEntries(base, paths, { maxChars, recursive = false }) {
  const out = [];
  let budget = maxChars;
  for (const p of paths) {
    let full;
    try {
      full = resolveInside(p, base);
    } catch (err) {
      out.push(`=== ${p}: ${err.message} ===`);
      continue;
    }
    const name = rel(full, base);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      out.push(`=== ${name}: not found ===`);
      continue;
    }
    if (st.isDirectory()) {
      out.push(`=== ${name}/ (directory) ===`, ...listDir(full, base, recursive));
      continue;
    }
    if (!st.isFile()) {
      out.push(`=== ${name}: not a regular file ===`);
      continue;
    }
    if (st.size > MAX_READ_FILE_BYTES) {
      out.push(`=== ${name} (${st.size} bytes): too large to return (limit ${MAX_READ_FILE_BYTES} bytes) ===`);
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (err) {
      out.push(`=== ${name}: cannot read (${err.code || err.message}) ===`);
      continue;
    }
    const hash = sha256(buf);
    const text = decodeText(buf);
    if (text === null) {
      out.push(`=== ${name} (${buf.length} bytes, sha256 ${hash}, binary or not UTF-8; content not shown) ===`);
      continue;
    }
    out.push(`=== ${name} (${buf.length} bytes, sha256 ${hash}, ${describeText(buf, text)}) ===`);
    if (text.length <= budget) {
      out.push(text);
      budget -= text.length;
    } else {
      out.push(text.slice(0, Math.max(budget, 0)));
      out.push(`[truncated: showing ${Math.max(budget, 0)} of ${text.length} chars; raise max_chars or read fewer files]`);
      budget = 0;
    }
  }
  return out.join('\n');
}

function hasGitSegment(p, base) {
  return path
    .relative(base, p)
    .split(/[\\/]+/)
    .some((seg) => seg.toLowerCase() === '.git');
}

/**
 * Write files inside `base`. Everything is validated before anything is
 * written. Returns one line per file with its size and sha256.
 */
export function writeEntries(base, files, { overwrite = false }) {
  const plan = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') throw new WorkspaceError('each entry in "files" must be an object');
    const { content } = f;
    const encoding = f.encoding || 'utf8';
    if (typeof content !== 'string') throw new WorkspaceError(`"content" of ${f.path} must be a string`);
    if (!['utf8', 'base64'].includes(encoding)) throw new WorkspaceError(`"encoding" of ${f.path} must be utf8 or base64`);
    const full = resolveInside(f.path, base);
    if (full === base) throw new WorkspaceError(`"${f.path}" is the workspace itself`);
    if (hasGitSegment(full, base)) throw new WorkspaceError(`refusing to write inside .git: ${f.path}`);
    if (plan.some((x) => x.full === full)) throw new WorkspaceError(`"${f.path}" is listed twice`);
    let data;
    if (encoding === 'base64') {
      const compact = content.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
        throw new WorkspaceError(`content of ${f.path} is not valid base64`);
      }
      data = Buffer.from(compact, 'base64');
    } else {
      data = Buffer.from(content, 'utf8');
    }
    if (typeof f.sha256 === 'string' && f.sha256 && f.sha256.toLowerCase() !== sha256(data)) {
      throw new WorkspaceError(`sha256 of ${f.path} does not match: expected ${f.sha256}, content has ${sha256(data)}`);
    }
    let exists = false;
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) throw new WorkspaceError(`"${f.path}" is a directory`);
      exists = true;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
    }
    if (exists && !overwrite) throw new WorkspaceError(`"${f.path}" already exists; pass overwrite: true to replace it`);
    total += data.length;
    if (total > MAX_WRITE_BYTES) throw new WorkspaceError(`too much data in one call (limit ${MAX_WRITE_BYTES} bytes)`);
    plan.push({ full, data, exists });
  }
  const lines = [];
  for (const { full, data, exists } of plan) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    lines.push(`${exists ? 'M' : 'A'} ${rel(full, base)} (${data.length} bytes, sha256 ${sha256(data)})`);
  }
  return lines.join('\n');
}
