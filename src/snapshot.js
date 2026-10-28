import fs from 'node:fs';
import path from 'node:path';

/**
 * A bounded before/after snapshot of a workspace, so files that Codex creates,
 * changes or deletes through shell commands show up in the change summary
 * (Codex only reports edits it makes with its own patch tool).
 */

export const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', '.gradle', '.idea', 'dist', 'build', 'target', '.next', '.nuxt', '.turbo', '.cache', 'coverage',
]);

/**
 * Walk `root` and record size + mtime of every file, skipping heavy or
 * generated directories. Returns null if the tree has more than `maxFiles`
 * files (too big to snapshot cheaply) or `maxFiles` is 0.
 */
export function takeSnapshot(root, maxFiles) {
  if (!maxFiles) return null;
  const files = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      files.set(full, `${st.size}:${Math.round(st.mtimeMs)}`);
      if (files.size > maxFiles) return null;
    }
  }
  return files;
}

/** Map of absolute path -> 'add' | 'update' | 'delete'. */
export function diffSnapshots(before, after) {
  const changes = new Map();
  if (!before || !after) return changes;
  for (const [p, sig] of after) {
    if (!before.has(p)) changes.set(p, 'add');
    else if (before.get(p) !== sig) changes.set(p, 'update');
  }
  for (const p of before.keys()) if (!after.has(p)) changes.set(p, 'delete');
  return changes;
}

/**
 * True when `p` is a file the snapshot of `root` would cover: inside `root`
 * and not under one of the skipped directories.
 */
export function isTracked(p, root) {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return !parts.slice(0, -1).some((d) => SKIP_DIRS.has(d));
}
