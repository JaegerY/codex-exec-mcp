import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read-only helpers for the user's Codex configuration. Nothing here writes to
 * the Codex config; it is only inspected to build per-run `-c` overrides.
 */

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

/**
 * Config files whose MCP servers are disabled in lean mode. Only the user-level
 * file: a project's `.codex/config.toml` is loaded only for trusted projects,
 * and disabling a server Codex never loaded would create an incomplete entry
 * and make Codex refuse to start.
 */
function configFilesFor(env = process.env) {
  return [path.join(codexHome(env), 'config.toml')];
}

// A table header naming exactly one MCP server: [mcp_servers.NAME] where NAME
// is a bare key or a quoted key. Sub-tables such as [mcp_servers.NAME.env] do
// not match.
const SERVER_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
// [mcp_servers] followed by `NAME = { ... }` inline tables.
const SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/;
const INLINE_ENTRY = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*\{/;
const ANY_HEADER = /^\s*\[/;

/** Names of the MCP servers defined in a config.toml text. */
export function mcpServerNames(tomlText) {
  const names = new Set();
  let inServersTable = false;
  for (const line of String(tomlText || '').split(/\r?\n/)) {
    const header = SERVER_HEADER.exec(line);
    if (header) {
      names.add(header[1] ?? header[2] ?? header[3]);
      inServersTable = false;
      continue;
    }
    if (SERVERS_TABLE.test(line)) {
      inServersTable = true;
      continue;
    }
    if (ANY_HEADER.test(line)) {
      inServersTable = false;
      continue;
    }
    if (inServersTable) {
      const entry = INLINE_ENTRY.exec(line);
      if (entry) names.add(entry[1] ?? entry[2] ?? entry[3]);
    }
  }
  return [...names];
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `-c` overrides that make a sub-agent run lean: plugins off and every MCP
 * server from the Codex config disabled, except those in `keep`.
 *
 * Codex splits `-c` keys on ".", so a server whose name contains a dot cannot
 * be addressed and is left enabled (reported in `skipped`).
 */
export function leanOverrides({ keep = [], env = process.env } = {}) {
  const keepSet = new Set(keep.map((k) => k.trim()).filter(Boolean));
  const disabled = [];
  const skipped = [];
  const sources = [];
  for (const file of configFilesFor(env)) {
    const text = readText(file);
    if (text === null) continue;
    sources.push(file);
    for (const name of mcpServerNames(text)) {
      if (keepSet.has(name) || disabled.includes(name) || skipped.includes(name)) continue;
      if (name.includes('.') || name.includes('=') || !name) skipped.push(name);
      else disabled.push(name);
    }
  }
  const args = ['-c', 'features.plugins=false'];
  for (const name of disabled) args.push('-c', `mcp_servers.${name}.enabled=false`);
  return { args, disabled, kept: [...keepSet], skipped, sources };
}
