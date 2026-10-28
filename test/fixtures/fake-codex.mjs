#!/usr/bin/env node
// A stand-in for the Codex CLI used by the tests. It mimics `codex --version`,
// `codex exec --help` and `codex exec [...] [resume ID] -` with --json events.
// Behaviour is driven by markers in the prompt, e.g. "[sleep:500]", "[fail]".
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const OLD = process.env.FAKE_CODEX_OLD === '1';
const argv = process.argv.slice(2);

const HELP_NEW = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  fork    Fork a previous session by id into a new session
  review  Run a code review against the current repository
  help    Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Initial instructions for the agent

Options:
  -m, --model <MODEL>
          Model the agent should use
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root
      --skip-git-repo-check
          Allow running Codex outside a Git repository
      --color <COLOR>
          [default: auto] [possible values: always, never, auto]
      --json
          Print events to stdout as JSONL
  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written
  -h, --help
          Print help
`;

const HELP_OLD = `Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -m, --model <MODEL>
  -C, --cd <DIR>
      --color <COLOR>
  -h, --help
`;

if (argv[0] === '--version') {
  console.log(OLD ? 'codex-cli 0.40.0' : 'codex-cli 0.163.0');
  process.exit(0);
}
if (argv[0] === 'exec' && argv.includes('--help')) {
  console.log(OLD ? HELP_OLD : HELP_NEW);
  process.exit(0);
}
if (argv[0] !== 'exec') {
  console.error(`fake codex: unsupported invocation ${argv.join(' ')}`);
  process.exit(2);
}

const opts = { json: false, out: null, cd: null, sandbox: null, model: null, skipGit: false, resume: null };
const rest = argv.slice(1);
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--json') opts.json = true;
  else if (a === '--output-last-message' || a === '-o') opts.out = rest[++i];
  else if (a === '--cd' || a === '-C') opts.cd = rest[++i];
  else if (a === '--sandbox' || a === '-s') opts.sandbox = rest[++i];
  else if (a === '--model' || a === '-m') opts.model = rest[++i];
  else if (a === '--color') i++;
  else if (a === '--skip-git-repo-check') opts.skipGit = true;
  else if (a === '-c') i++;
  else positional.push(a);
}
if (positional[0] === 'resume') {
  opts.resume = positional[1];
  positional.splice(0, 2);
}
if (positional[0] !== '-') {
  console.error('fake codex: expected "-" to read the prompt from stdin');
  process.exit(2);
}

const prompt = fs.readFileSync(0, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (ev) => {
  if (opts.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
};
const threadId = opts.resume || `019a0000-0000-7000-8000-${String(Date.now()).slice(-12)}`;

if (process.env.FAKE_CODEX_PIDFILE) fs.writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(process.pid));

process.stderr.write('Reading prompt from stdin...\n');
emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });

if (prompt.includes('[fail]')) {
  process.stderr.write('ERROR: stream error: unexpected status 401 Unauthorized (fake provider)\n');
  process.exit(1);
}

if (prompt.includes('[tree]')) {
  // Start a grandchild that would outlive us if not killed as a tree.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_CODEX_PIDFILE) fs.writeFileSync(`${process.env.FAKE_CODEX_PIDFILE}.child`, String(grandchild.pid));
}

if (prompt.includes('[hang]') || prompt.includes('[tree]')) {
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep forever', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  setInterval(() => {}, 1000);
} else {
  const sleepMatch = /\[sleep:(\d+)\]/.exec(prompt);
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Planning the change**' } });
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  if (sleepMatch) await sleep(Number(sleepMatch[1]));
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'a\nb\n', exit_code: 0, status: 'completed' } });
  if (prompt.includes('[files]')) {
    emit({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'npm test', aggregated_output: 'fail', exit_code: 1, status: 'failed' } });
    emit({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }, { path: 'src/b.js', kind: 'add' }], status: 'completed' } });
  }
  // Shell-style file changes that produce no file_change event.
  for (const m of prompt.matchAll(/\[touch:([^\]]+)\]/g)) {
    const target = m[1];
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, `made by fake codex ${Date.now()}`);
  }
  for (const m of prompt.matchAll(/\[rm:([^\]]+)\]/g)) fs.rmSync(m[1], { force: true });
  if (prompt.includes('[turnfail]')) {
    emit({ type: 'turn.failed', error: { message: 'model provider returned 500' } });
    process.exit(1);
  }
  let message = 'Done. Changed things.';
  if (prompt.includes('[echoargs]')) message = JSON.stringify({ argv, cwd: process.cwd(), prompt, opts });
  if (prompt.includes('[big]')) message = 'x'.repeat(50000);
  if (prompt.includes('[unicode]')) message = '完成：已修改 2 个文件 ✅';
  const exact = /Reply with exactly: (\S+)/.exec(prompt);
  if (exact) message = exact[1];
  emit({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: message } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, reasoning_output_tokens: 10 } });
  if (opts.out) fs.writeFileSync(opts.out, message);
  if (!opts.json) process.stdout.write(`codex\n${message}\n`);
  process.exit(0);
}
