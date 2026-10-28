import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAlive, startServer, tempProject, waitUntil } from './helpers.js';

test('codex_run completes and returns message, session id and change summary', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: 'do it [files]', cwd });
    assert.equal(r.isError, false);
    assert.match(r.text, /^Done\. Changed things\./);
    assert.match(r.text, /status: completed/);
    assert.match(r.text, /session_id: 019a/);
    assert.match(r.text, /commands: 2 \(1 failed\)/);
    assert.match(r.text, /files changed: 2/);
    assert.match(r.text, / M src\/a\.js/);
    assert.match(r.text, / A src\/b\.js/);
    assert.match(r.text, /codex tokens: in 1200 \(cached 800\) \/ out 90/);
  } finally {
    await s.close();
  }
});

test('codex_run passes cwd, sandbox, model and reads the prompt from stdin', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const prompt = '[echoargs] 多行\n提示词 with "quotes" & <pipes> | %PATH%';
    const r = await s.call('codex_run', { prompt, cwd, sandbox: 'read-only', model: 'deepseek-v4' });
    const echoed = JSON.parse(r.text.split('\n---')[0]);
    assert.equal(echoed.prompt, prompt, 'prompt arrives byte-for-byte over stdin');
    assert.equal(echoed.cwd, cwd);
    assert.equal(echoed.opts.cd, cwd);
    assert.equal(echoed.opts.sandbox, 'read-only');
    assert.equal(echoed.opts.model, 'deepseek-v4');
    assert.equal(echoed.opts.json, true);
    assert.equal(echoed.opts.skipGit, true);
    assert.ok(echoed.argv.at(-1) === '-');
  } finally {
    await s.close();
  }
});

test('session_id resumes via "codex exec resume <id> -"', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[echoargs] continue', cwd, session_id: 'abc-123' });
    const echoed = JSON.parse(r.text.split('\n---')[0]);
    assert.equal(echoed.opts.resume, 'abc-123');
    assert.match(r.text, /session_id: abc-123/);
  } finally {
    await s.close();
  }
});

test('long task returns a job_id, then codex_status delivers the result', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: 'slow [sleep:1500]', cwd, wait_sec: 0 });
    assert.match(r.text, /status: running/);
    const jobId = /job_id: (j_\w+)/.exec(r.text)[1];

    const early = await s.call('codex_status', { job_id: jobId, wait_sec: 0 });
    assert.match(early.text, /status: running/);

    const done = await s.call('codex_status', { job_id: jobId, wait_sec: 10 });
    assert.match(done.text, /status: completed/);
    assert.match(done.text, /^Done\./);

    const list = await s.call('codex_status', {});
    assert.match(list.text, new RegExp(`${jobId} \\| completed`));
  } finally {
    await s.close();
  }
});

test('progress notifications are sent while waiting when a progressToken is given', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    await s.call('codex_run', { prompt: '[sleep:1200]', cwd, wait_sec: 10 }, { _meta: { progressToken: 'tok-1' } });
    const progress = s.notifications.filter((n) => n.method === 'notifications/progress');
    assert.ok(progress.length >= 2, `expected progress notifications, got ${progress.length}`);
    assert.equal(progress[0].params.progressToken, 'tok-1');
    assert.ok(progress[1].params.progress > progress[0].params.progress, 'progress increases');
    assert.match(progress[0].params.message, /^Codex /);
  } finally {
    await s.close();
  }
});

test('codex failure is reported with stderr so the model can explain it', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[fail]', cwd });
    assert.equal(r.isError, true);
    assert.match(r.text, /status: failed/);
    assert.match(r.text, /401 Unauthorized/);
    assert.match(r.text, /logs: /);

    const t = await s.call('codex_run', { prompt: '[turnfail]', cwd });
    assert.equal(t.isError, true);
    assert.match(t.text, /model provider returned 500/);
  } finally {
    await s.close();
  }
});

test('codex_cancel kills Codex and the processes it started', async () => {
  const cwd = tempProject();
  const pidFile = path.join(os.tmpdir(), `cem-pid-${process.pid}-${Date.now()}`);
  const s2 = startServer({ FAKE_CODEX_PIDFILE: pidFile });
  try {
    await s2.initialize();
    const r = await s2.call('codex_run', { prompt: '[tree]', cwd, wait_sec: 0 });
    const jobId = /job_id: (j_\w+)/.exec(r.text)[1];
    assert.ok(await waitUntil(() => fs.existsSync(`${pidFile}.child`)), 'grandchild started');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const childPid = Number(fs.readFileSync(`${pidFile}.child`, 'utf8'));
    assert.ok(isAlive(pid) && isAlive(childPid));

    const c = await s2.call('codex_cancel', { job_id: jobId });
    assert.match(c.text, /Cancelled job/);
    assert.ok(await waitUntil(() => !isAlive(pid) && !isAlive(childPid), 6000), 'codex and its child are gone');

    const st = await s2.call('codex_status', { job_id: jobId, wait_sec: 0 });
    assert.match(st.text, /status: cancelled/);
  } finally {
    await s2.close();
  }
});

test('timeout_sec stops a hung Codex', async () => {
  const s = startServer();
  const cwd = tempProject();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[hang]', cwd, timeout_sec: 10, wait_sec: 20 });
    assert.equal(r.isError, true);
    assert.match(r.text, /status: timed_out/);
  } finally {
    await s.close();
  }
});

test('closing the MCP connection stops running Codex jobs', async () => {
  const pidFile = path.join(os.tmpdir(), `cem-pid2-${process.pid}-${Date.now()}`);
  const s = startServer({ FAKE_CODEX_PIDFILE: pidFile });
  const cwd = tempProject();
  await s.initialize();
  await s.call('codex_run', { prompt: '[hang]', cwd, wait_sec: 0 });
  assert.ok(await waitUntil(() => fs.existsSync(pidFile)));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pid));
  await s.close();
  assert.ok(await waitUntil(() => !isAlive(pid), 6000), 'orphaned codex was killed');
});

test('client cancellation of a blocking codex_run stops the job and sends no response', async () => {
  const pidFile = path.join(os.tmpdir(), `cem-pid3-${process.pid}-${Date.now()}`);
  const s = startServer({ FAKE_CODEX_PIDFILE: pidFile });
  const cwd = tempProject();
  try {
    await s.initialize();
    const reqId = 777;
    s.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name: 'codex_run', arguments: { prompt: '[hang]', cwd, wait_sec: 60 } } })}\n`);
    assert.ok(await waitUntil(() => fs.existsSync(pidFile)));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    s.notify('notifications/cancelled', { requestId: reqId, reason: 'user pressed stop' });
    assert.ok(await waitUntil(() => !isAlive(pid), 6000), 'codex stopped after cancellation');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!s.rawLines.some((l) => JSON.parse(l).id === reqId), 'no response for a cancelled request');
  } finally {
    await s.close();
  }
});

test('output is truncated to CODEX_MCP_MAX_OUTPUT_CHARS and unicode survives', async () => {
  const s = startServer({ CODEX_MCP_MAX_OUTPUT_CHARS: '1000' });
  const cwd = tempProject();
  try {
    await s.initialize();
    const big = await s.call('codex_run', { prompt: '[big]', cwd });
    assert.match(big.text, /\[truncated: 50000 chars total; full text in /);
    assert.ok(big.text.length < 3000);
    const u = await s.call('codex_run', { prompt: '[unicode]', cwd });
    assert.match(u.text, /完成：已修改 2 个文件 ✅/);
  } finally {
    await s.close();
  }
});

test('guard rails: allowed roots, danger sandbox, bad input, concurrency', async () => {
  const allowed = tempProject();
  const outside = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: allowed, CODEX_MCP_MAX_CONCURRENT: '1' });
  try {
    await s.initialize();
    const out = await s.call('codex_run', { prompt: 'x', cwd: outside });
    assert.equal(out.isError, true);
    assert.match(out.text, /outside CODEX_MCP_ALLOWED_ROOTS/);

    const danger = await s.call('codex_run', { prompt: 'x', cwd: allowed, sandbox: 'danger-full-access' });
    assert.equal(danger.isError, true);
    assert.match(danger.text, /CODEX_MCP_ALLOW_DANGER/);

    const rel = await s.call('codex_run', { prompt: 'x', cwd: 'relative/dir' });
    assert.match(rel.text, /absolute path/);

    const missing = await s.call('codex_run', { cwd: allowed });
    assert.match(missing.text, /"prompt" is required/);

    const badSession = await s.call('codex_run', { prompt: 'x', cwd: allowed, session_id: 'a b; rm -rf' });
    assert.match(badSession.text, /invalid characters/);

    const first = await s.call('codex_run', { prompt: '[sleep:1500]', cwd: allowed, wait_sec: 0 });
    assert.match(first.text, /status: running/);
    const second = await s.call('codex_run', { prompt: 'x', cwd: allowed });
    assert.equal(second.isError, true);
    assert.match(second.text, /Too many Codex jobs running/);
  } finally {
    await s.close();
  }
});

test('home directory is refused when no allow-list is configured', async () => {
  const s = startServer();
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: 'x', cwd: os.homedir() });
    assert.equal(r.isError, true);
    assert.match(r.text, /home directory/);
  } finally {
    await s.close();
  }
});

test('old Codex without --json / -o / resume still works and is reported', async () => {
  const s = startServer({ FAKE_CODEX_OLD: '1' });
  const cwd = tempProject();
  try {
    await s.initialize();
    const info = await s.call('codex_info');
    assert.match(info.text, /codex version: 0\.40\.0/);
    assert.match(info.text, /json=no/);
    assert.match(info.text, /cannot resume/);
    const r = await s.call('codex_run', { prompt: 'hello', cwd });
    assert.equal(r.isError, false);
    assert.match(r.text, /Done\. Changed things\./);
    const resume = await s.call('codex_run', { prompt: 'hello', cwd, session_id: 'abc' });
    assert.equal(resume.isError, true);
    assert.match(resume.text, /does not support "codex exec resume"/);
  } finally {
    await s.close();
  }
});

test('a missing Codex binary produces a clear, actionable error', async () => {
  const s = startServer({ CODEX_MCP_CODEX_PATH: path.join(os.tmpdir(), 'definitely-not-codex.js') });
  const cwd = tempProject();
  try {
    await s.initialize();
    const info = await s.call('codex_info');
    assert.match(info.text, /NOT AVAILABLE/);
    const r = await s.call('codex_run', { prompt: 'x', cwd });
    assert.equal(r.isError, true);
    assert.match(r.text, /CODEX_MCP_CODEX_PATH/);
  } finally {
    await s.close();
  }
});

test('invalid configuration makes the server exit with a message instead of misbehaving', async () => {
  const s = startServer({ CODEX_MCP_DEFAULT_SANDBOX: 'yolo' });
  const code = await s.exited;
  assert.equal(code, 1);
  assert.match(s.stderr, /CODEX_MCP_DEFAULT_SANDBOX must be one of/);
});
