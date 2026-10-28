import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WINDOWS_SANDBOX_MODES } from './config.js';

/**
 * `codex-exec-mcp install` / `uninstall`: register this server in Claude
 * Desktop's config file. Only the `mcpServers.<name>` entry is touched; the
 * rest of the file is kept as is, and a backup is written first.
 */

/**
 * Claude Desktop installed as a Windows app package (MSIX: Microsoft Store,
 * WinGet or a packaged installer) reads its config
 * from a virtualised AppData under %LOCALAPPDATA%\Packages\Claude_<id>, not
 * from %APPDATA%. Returns those candidate files, newest first.
 */
function msixConfigCandidates(env) {
  const packages = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  let names = [];
  try {
    names = fs.readdirSync(packages).filter((n) => /^Claude_[a-z0-9]+$/i.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(packages, n, 'LocalCache', 'Roaming', 'Claude'))
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, 'claude_desktop_config.json'))
    .sort((a, b) => mtime(b) - mtime(a));
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function desktopConfigPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const msix = msixConfigCandidates(env);
    if (msix.length) return msix[0];
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

export function parseInstallArgs(argv) {
  const opts = { roots: [], name: 'codex', lean: true, windowsSandbox: '', config: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--root') opts.roots.push(path.resolve(value()));
    else if (a === '--name') opts.name = value();
    else if (a === '--no-lean') opts.lean = false;
    else if (a === '--windows-sandbox') opts.windowsSandbox = value();
    else if (a === '--config') opts.config = path.resolve(value());
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!/^[\w-]+$/.test(opts.name)) throw new Error('--name may only contain letters, digits, "_" and "-"');
  if (opts.windowsSandbox && !WINDOWS_SANDBOX_MODES.includes(opts.windowsSandbox)) {
    throw new Error(`--windows-sandbox must be one of ${WINDOWS_SANDBOX_MODES.join(', ')}`);
  }
  for (const r of opts.roots) {
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) throw new Error(`--root ${r} is not an existing directory`);
  }
  return opts;
}

/** The MCP server entry for this installation. */
export function buildEntry(opts, { nodePath = process.execPath, scriptPath, existing } = {}) {
  const env = { ...((existing && existing.env) || {}) };
  if (opts.roots.length) {
    env.CODEX_MCP_ALLOWED_ROOTS = opts.roots.join(path.delimiter);
    env.CODEX_MCP_DEFAULT_CWD = opts.roots[0];
  }
  if (opts.lean) env.CODEX_MCP_LEAN = '1';
  else delete env.CODEX_MCP_LEAN;
  if (opts.windowsSandbox) env.CODEX_MCP_WINDOWS_SANDBOX = opts.windowsSandbox;
  const entry = { command: nodePath, args: [scriptPath] };
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
    return data;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix or remove it first, nothing was changed`);
  }
}

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Returns the lines to print. Throws on bad input without touching the file. */
export function install(argv, { scriptPath, log = () => {} } = {}) {
  const opts = parseInstallArgs(argv);
  const file = opts.config || desktopConfigPath();
  const data = readConfig(file);
  const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
  const existing = servers[opts.name];
  const entry = buildEntry(opts, { scriptPath, existing });
  const next = { ...data, mcpServers: { ...servers, [opts.name]: entry } };

  if (/[\\/]_npx[\\/]/.test(scriptPath)) {
    log('warning: running from the npx cache, whose path can change. For a stable install run "npm i -g codex-exec-mcp" and then "codex-exec-mcp install".');
  }
  if (!opts.roots.length && !(existing && existing.env && existing.env.CODEX_MCP_ALLOWED_ROOTS)) {
    log('note: no --root given; Codex may then work in any folder except your home directory and the filesystem root. Recommended: --root <your projects folder>.');
  }
  if (/[\\/]Packages[\\/]Claude_/i.test(file)) log('Detected Claude Desktop installed as a Windows app package (MSIX); using its packaged config file.');
  log(`${opts.dryRun ? 'Would write' : 'Writing'} mcpServers.${opts.name} to ${file}:`);
  log(JSON.stringify(entry, null, 2));
  if (opts.dryRun) return;
  writeConfig(file, next);
  log(`Done${existing ? ' (updated the existing entry; a backup was saved next to the file)' : ''}.`);
  log('Fully quit Claude Desktop (tray / menu bar → Quit) and start it again. Then ask Claude to call codex_info.');
  log('');
  log('Claude Code: install the plugin instead (see README), or run:');
  log(`  claude mcp add ${opts.name} --scope user -- "${process.execPath}" "${scriptPath}"`);
}

export function uninstall(argv, { log = () => {} } = {}) {
  const opts = parseInstallArgs(argv);
  const file = opts.config || desktopConfigPath();
  const data = readConfig(file);
  if (!data.mcpServers || !data.mcpServers[opts.name]) {
    log(`Nothing to remove: no mcpServers.${opts.name} in ${file}.`);
    return;
  }
  const servers = { ...data.mcpServers };
  delete servers[opts.name];
  if (!opts.dryRun) writeConfig(file, { ...data, mcpServers: servers });
  log(`${opts.dryRun ? 'Would remove' : 'Removed'} mcpServers.${opts.name} from ${file}. Restart Claude Desktop.`);
}
