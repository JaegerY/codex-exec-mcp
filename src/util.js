import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/** Human-readable duration, e.g. 1m32s. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** Keep the start of a string. */
export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** Keep the end of a string. */
export function tail(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/** One-line preview, whitespace collapsed. */
export function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function newJobId() {
  return `j_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

/** Resolve symlinks/junctions; fall back to path.resolve when the path does not exist. */
export function realpathOrResolve(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normalizeForCompare(p, platform) {
  const n = path.normalize(p);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** True when `child` is `parent` or inside it. */
export function isWithin(child, parent, platform = process.platform) {
  const c = normalizeForCompare(child, platform);
  const p = normalizeForCompare(parent, platform);
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when both paths name the same directory. */
export function samePath(a, b, platform = process.platform) {
  return isWithin(a, b, platform) && isWithin(b, a, platform);
}

export function isTruthy(value) {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}
