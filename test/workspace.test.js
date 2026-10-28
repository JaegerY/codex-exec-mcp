import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempProject } from './helpers.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function toolNames(s) {
  const res = await s.request('tools/list', {});
  return res.result.tools.map((t) => t.name).sort();
}

test('file tools are offered according to CODEX_MCP_FILE_TOOLS and allowed roots', async () => {
  const root = tempProject();
  const cases = [
    [{}, ['codex_cancel', 'codex_info', 'codex_output', 'codex_run', 'codex_status', 'workspace_read']],
    [{ CODEX_MCP_ALLOWED_ROOTS: root }, ['codex_cancel', 'codex_info', 'codex_output', 'codex_run', 'codex_status', 'workspace_read', 'workspace_write']],
    [{ CODEX_MCP_ALLOWED_ROOTS: root, CODEX_MCP_FILE_TOOLS: 'off' }, ['codex_cancel', 'codex_info', 'codex_output', 'codex_run', 'codex_status']],
    [{ CODEX_MCP_FILE_TOOLS: 'readwrite' }, ['codex_cancel', 'codex_info', 'codex_output', 'codex_run', 'codex_status', 'workspace_read', 'workspace_write']],
  ];
  for (const [env, expected] of cases) {
    const s = startServer(env);
    try {
      await s.initialize();
      assert.deepEqual(await toolNames(s), expected, JSON.stringify(env));
      if (!expected.includes('workspace_write')) {
        const r = await s.call('workspace_write', { cwd: root, files: [{ path: 'x.txt', content: 'x' }] });
        assert.equal(r.isError, true);
        assert.match(r.text, /turned off/);
      }
    } finally {
      await s.close();
    }
  }
});

test('workspace_write writes bytes exactly and workspace_read returns them with sha256', async () => {
  const root = tempProject();
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: root });
  const text = 'line1\r\n中文 ✅\r\n\tend';
  const bin = Buffer.from([0, 1, 2, 255, 254]);
  try {
    await s.initialize();
    const w = await s.call('workspace_write', {
      cwd: root,
      files: [
        { path: 'proj/a.txt', content: text },
        { path: 'proj/bom.csv', content: '\ufeffid,name\n1,x\n' },
        { path: 'proj/bin.dat', content: bin.toString('base64'), encoding: 'base64', sha256: sha(bin) },
      ],
    });
    assert.equal(w.isError, false, w.text);
    assert.match(w.text, new RegExp(`A proj/a\\.txt \\(${Buffer.byteLength(text)} bytes, sha256 ${sha(Buffer.from(text))}\\)`));
    assert.deepEqual(fs.readFileSync(path.join(root, 'proj', 'a.txt')), Buffer.from(text, 'utf8'), 'no newline conversion');
    assert.deepEqual(fs.readFileSync(path.join(root, 'proj', 'bin.dat')), bin);

    const r = await s.call('workspace_read', { cwd: path.join(root, 'proj'), paths: ['a.txt', 'bom.csv', 'bin.dat', 'missing.txt', '.'] });
    assert.equal(r.isError, false);
    assert.ok(r.text.includes(`=== a.txt (${Buffer.byteLength(text)} bytes, sha256 ${sha(Buffer.from(text))}, utf-8, CRLF) ===\n${text}\n`), r.text);
    assert.match(r.text, /=== bom\.csv \(\d+ bytes, sha256 \w+, utf-8, BOM\) ===/);
    assert.match(r.text, new RegExp(`=== bin\\.dat \\(5 bytes, sha256 ${sha(bin)}, binary or not UTF-8; content not shown\\) ===`));
    assert.match(r.text, /=== missing\.txt: not found ===/);
    assert.match(r.text, /=== \.\/ \(directory\) ===\n {2}f a\.txt/);
  } finally {
    await s.close();
  }
});

test('workspace_write refuses unsafe or invalid input and writes nothing', async () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, 'keep.txt'), 'original');
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const s = startServer({ CODEX_MCP_ALLOWED_ROOTS: root });
  const bad = [
    [[{ path: '../escape.txt', content: 'x' }], /outside the workspace/],
    [[{ path: path.join(outside, 'abs.txt'), content: 'x' }], /outside the workspace/],
    [[{ path: 'link/through-symlink.txt', content: 'x' }], /outside the workspace/],
    [[{ path: '.git/config', content: 'x' }], /inside \.git/],
    [[{ path: 'keep.txt', content: 'new' }], /already exists/],
    [[{ path: 'b.bin', content: '***', encoding: 'base64' }], /not valid base64/],
    [[{ path: 'h.txt', content: 'abc', sha256: '00' }], /does not match/],
    [[{ path: 'ok-first.txt', content: 'x' }, { path: '../late-bad.txt', content: 'x' }], /outside the workspace/],
  ];
  try {
    await s.initialize();
    for (const [files, re] of bad) {
      const r = await s.call('workspace_write', { cwd: root, files });
      assert.equal(r.isError, true, JSON.stringify(files));
      assert.match(r.text, re);
    }
    assert.equal(fs.existsSync(path.join(root, 'ok-first.txt')), false, 'nothing is written when any entry is invalid');
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'original');

    const ok = await s.call('workspace_write', { cwd: root, files: [{ path: 'keep.txt', content: 'new' }], overwrite: true });
    assert.match(ok.text, /M keep\.txt/);

    const outsideCwd = await s.call('workspace_read', { cwd: outside, paths: ['.'] });
    assert.equal(outsideCwd.isError, true);
    assert.match(outsideCwd.text, /outside CODEX_MCP_ALLOWED_ROOTS/);
    const escape = await s.call('workspace_read', { cwd: root, paths: ['../', 'link/x'] });
    assert.match(escape.text, /outside the workspace/);
  } finally {
    await s.close();
  }
});

test('workspace_read limits total text with max_chars', async () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, 'big.txt'), 'z'.repeat(5000));
  const s = startServer();
  try {
    await s.initialize();
    const r = await s.call('workspace_read', { cwd: root, paths: ['big.txt'], max_chars: 300 });
    assert.match(r.text, /\[truncated: showing 300 of 5000 chars/);
  } finally {
    await s.close();
  }
});

test('codex_output returns verbatim command output, by number or match, also after a restart', async () => {
  const cwd = tempProject();
  const s = startServer();
  let jobId;
  let logDir;
  try {
    await s.initialize();
    const r = await s.call('codex_run', { prompt: '[files] [bigout:30000]', cwd });
    jobId = /job_id: (j_\w+)/.exec(r.text)[1];
    logDir = s.logDir;
    assert.match(r.text, /commands; verbatim output via codex_output job_id "j_\w+" command N:/);
    assert.match(r.text, / {2}#3 exit 0 \$ python -m unittest -v/, 'shell wrapper is dropped in the preview');

    const list = await s.call('codex_output', { job_id: jobId });
    assert.match(list.text, /#1 exit 0 \$ ls \(4 chars\)/);
    assert.match(list.text, /#2 exit 1 \$ npm test \(4 chars\)/);

    const first = await s.call('codex_output', { job_id: jobId, command: 1 });
    assert.ok(first.text.endsWith('--- output ---\na\nb\n'), first.text);

    const last = await s.call('codex_output', { job_id: jobId, match: 'UNITTEST' });
    assert.match(last.text, /^#3 \$ "C:\\Windows/);
    assert.match(last.text, /showing last 20000 chars/);
    assert.ok(last.text.endsWith('-TAIL\nRan 7 tests OK\n'));

    const head = await s.call('codex_output', { job_id: jobId, command: -1, max_chars: 300, head: true });
    assert.match(head.text, /--- output ---\nHEAD-y+$/);

    const none = await s.call('codex_output', { job_id: jobId, command: 9 });
    assert.equal(none.isError, true);
    assert.match(none.text, /has 3 finished command\(s\)/);
  } finally {
    await s.close();
  }

  // A new server process has no jobs in memory but reads the job's log folder.
  const s2 = startServer({ CODEX_MCP_LOG_DIR: logDir });
  try {
    await s2.initialize();
    const r = await s2.call('codex_output', { job_id: jobId, command: 2 });
    assert.match(r.text, /exit: 1 .*\(read from the log folder\)/);
    assert.ok(r.text.endsWith('--- output ---\nfail'));
    const unknown = await s2.call('codex_output', { job_id: 'j_doesnotexist' });
    assert.equal(unknown.isError, true);
  } finally {
    await s2.close();
  }
});
