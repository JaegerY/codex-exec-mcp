#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { CodexCli } from '../src/codex.js';
import { JobManager } from '../src/jobs.js';
import { McpServer } from '../src/protocol.js';
import { createTools, formatFinished } from '../src/tools.js';
import { install, uninstall } from '../src/install.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const INSTRUCTIONS = [
  'Use these tools to hand coding work to Codex, an autonomous coding agent running on the user\'s machine with the user\'s own model provider.',
  'Good uses: implementing a well-specified change, refactoring, writing tests, investigating a bug, reviewing code (sandbox "read-only").',
  'Give codex_run a self-contained brief and an absolute cwd; ask Codex to finish with a short summary so the reply stays small.',
  'If codex_run returns status "running", keep calling codex_status with the job_id until it finishes.',
  'Check Codex\'s work yourself before reporting success: read changed files with workspace_read and real command output (e.g. test runs) with codex_output, rather than relying on Codex\'s summary.',
  'To put exact content into a workspace (a seed project, an acceptance script, test data), use workspace_write instead of asking Codex to type it.',
].join(' ');

const HELP = `codex-exec-mcp ${pkg.version}
MCP server that lets Claude (or any MCP client) delegate tasks to the Codex CLI.

Usage:
  codex-exec-mcp              Start the MCP server on stdio (what MCP clients run)
  codex-exec-mcp install [--root DIR]... [--windows-sandbox unelevated|elevated] [--no-lean]
                         [--name codex] [--config FILE] [--dry-run]
                              Register this server in Claude Desktop (backup first, other
                              entries untouched). Lean mode is on unless --no-lean.
  codex-exec-mcp uninstall [--name codex] [--config FILE]
  codex-exec-mcp doctor       Check that Codex can be found and print the detected setup
  codex-exec-mcp doctor --live [--cwd DIR]
                              Also run a tiny real Codex task (uses a few model tokens)
  codex-exec-mcp --version

Configuration is read from environment variables, see README.md
(CODEX_MCP_DEFAULT_CWD, CODEX_MCP_ALLOWED_ROOTS, CODEX_MCP_DEFAULT_SANDBOX, ...).
`;

async function doctor(argv) {
  const live = argv.includes('--live');
  const cwdIdx = argv.indexOf('--cwd');
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`config error: ${err.message}`);
    return 1;
  }
  const codex = new CodexCli(config);
  const jobs = new JobManager(config, codex);
  const { handlers } = createTools({ config, codex, jobs, serverVersion: pkg.version });
  const info = await handlers.codex_info({});
  console.log(info.text);
  if (/NOT AVAILABLE/.test(info.text)) return 1;
  if (!live) {
    console.log('\nOK. Run "codex-exec-mcp doctor --live" to also test a real Codex call with your model provider.');
    return 0;
  }
  const cwd = cwdIdx >= 0 && argv[cwdIdx + 1] ? path.resolve(argv[cwdIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-mcp-doctor-'));
  console.log(`\nRunning a live test in ${cwd} (read-only sandbox)…`);
  try {
    const job = await jobs.start({
      prompt: 'This is a connectivity test. Do not run any commands or edit files. Reply with exactly: CODEX_EXEC_MCP_OK',
      cwd,
      sandbox: 'read-only',
      model: config.defaultModel,
      timeoutSec: 300,
    });
    await job.done;
    console.log(formatFinished(job, config));
    const ok = job.state === 'completed' && /CODEX_EXEC_MCP_OK/.test(job.finalMessage);
    console.log(ok ? '\nLive test passed.' : '\nLive test FAILED. Check the error and codex stderr above.');
    return ok ? 0 : 1;
  } catch (err) {
    console.error(`Live test failed to start: ${err.message}`);
    return 1;
  }
}

async function serve() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Fail loudly: a misconfigured server should not silently start.
    process.stderr.write(`[codex-exec-mcp] configuration error: ${err.message}\n`);
    process.exit(1);
  }
  const codex = new CodexCli(config);
  const jobs = new JobManager(config, codex);
  const tools = createTools({ config, codex, jobs, serverVersion: pkg.version });
  const server = new McpServer({
    serverInfo: { name: 'codex-exec-mcp', title: 'Codex (codex exec)', version: pkg.version },
    instructions: INSTRUCTIONS,
    tools,
  });

  let shuttingDown = false;
  const shutdown = (reason, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const running = jobs.running().length;
    server.log(`shutting down (${reason})${running ? `, stopping ${running} Codex job(s)` : ''}`);
    jobs.cancelAll();
    // Give taskkill / SIGTERM a moment to reach the children.
    setTimeout(() => process.exit(code), running ? 1500 : 50).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => server.log(`uncaught exception: ${err && err.stack ? err.stack : err}`));
  process.on('unhandledRejection', (err) => server.log(`unhandled rejection: ${err && err.stack ? err.stack : err}`));

  server.log(`v${pkg.version} ready (node ${process.version}, ${process.platform})`);
  // Warm up feature detection so the first tool call is fast; errors surface later.
  codex.detect().catch((err) => server.log(`codex not ready yet: ${err.message}`));

  await server.serve(process.stdin, process.stdout);
  shutdown('client closed stdin');
}

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(pkg.version);
} else if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
} else if (argv[0] === 'doctor' || argv.includes('--doctor')) {
  doctor(argv).then((code) => process.exit(code));
} else if (argv[0] === 'install' || argv[0] === 'uninstall') {
  try {
    const run = argv[0] === 'install' ? install : uninstall;
    run(argv.slice(1), { scriptPath: SCRIPT, log: (line) => console.log(line) });
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
} else if (argv.length) {
  console.error(`error: unknown command "${argv[0]}". Run with --help.`);
  process.exit(1);
} else {
  serve();
}
