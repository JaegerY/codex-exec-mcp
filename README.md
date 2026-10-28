# codex-exec-mcp

[中文说明](README.zh-CN.md)

Let Claude (Claude Desktop, Claude Code) or any MCP client hand coding tasks to the [Codex CLI](https://github.com/openai/codex) as a sub-agent.

Codex runs with **your own Codex configuration**, so whichever model provider you set up in `~/.codex/config.toml` (OpenAI, DeepSeek, a local model, …) does the work. Typical use: Claude writes the spec and checks the result, Codex writes the code, and your Claude usage goes much further.

- **Zero dependencies.** Plain Node.js. The MCP protocol is implemented directly, so an SDK release cannot break it.
- **Old and new MCP clients.** Supports both the `initialize` handshake (2024-11-05 … 2025-11-25) and the stateless 2026-07-28 protocol with `server/discover`. Responses are validated against the official JSON schemas.
- **Survives Codex upgrades.** Uses the documented `codex exec --json` (not the removed `codex mcp-server` or the experimental app-server). Flags are detected at runtime.
- **No client timeouts.** `codex_run` waits up to 45 s, then returns a `job_id`; `codex_status` waits again. Long tasks never hit a 60 s tool limit.
- **Small replies.** Claude gets Codex's final message plus a change summary (files, commands, tokens), not the transcript. Files changed by shell commands are included.
- **Lean mode.** Turns off Codex plugins and your Codex MCP servers for sub-agent runs only. In one measurement this cut per-request context from ~118k to ~14k tokens.
- **Clean process handling.** Cancel, timeout or client exit kills Codex and everything it started. Works on Windows, macOS and Linux.

## Requirements

- Node.js 18.17+
- Codex CLI (`npm i -g @openai/codex`). Check that `codex exec "say hi"` works in a terminal first.

## Install

### Claude Code: plugin (MCP server + workflow skill)

```text
/plugin marketplace add JaegerY/codex-exec-mcp
/plugin install codex-exec@codex-exec-mcp
```

The plugin starts the server with lean mode on and adds the `codex-delegate` skill. Ask "let Codex implement …" and Claude writes a spec, delegates, verifies the result independently and sends defects back to Codex.

### Claude Desktop: one command

```bash
npm i -g codex-exec-mcp
codex-exec-mcp install --root /path/to/your/projects
# Windows example:
codex-exec-mcp install --root C:\Users\me\projects --windows-sandbox unelevated
```

This adds an `mcpServers.codex` entry to Claude Desktop's config (it also finds the config of MSIX-packaged installs (Microsoft Store, WinGet, packaged installers) under `%LOCALAPPDATA%\Packages\Claude_*`). It backs up the file first, leaves every other entry alone, and uses absolute paths, so `PATH` problems cannot break it. Running it again updates the entry. Then fully quit Claude Desktop (tray / menu bar → Quit) and start it again. Remove the entry with `codex-exec-mcp uninstall`.

| `install` option | Meaning |
|---|---|
| `--root DIR` (repeatable) | Folders Codex may work in. The first one is the default. Strongly recommended. |
| `--windows-sandbox unelevated` | Windows: run commands sandboxed as your user. See [Windows notes](#windows-notes). |
| `--no-lean` | Keep your Codex plugins and MCP servers available to the sub-agent. |
| `--name NAME`, `--config FILE`, `--dry-run` | Entry name (default `codex`), another config file, show without writing. |

Not published to npm yet? Clone the repository and run `node cli/codex-exec-mcp.js install …` from it.

To use the workflow in Claude Desktop too, add `skills/codex-delegate/SKILL.md` as a skill.

### Other MCP clients (Cursor, Windsurf, VS Code, …)

Command `node`, argument `/absolute/path/to/codex-exec-mcp/cli/codex-exec-mcp.js`. Settings go in `env` (see [Configuration](#configuration)).

### Check it

```bash
codex-exec-mcp doctor          # finds Codex, shows detected features; no tokens used
codex-exec-mcp doctor --live   # also runs one tiny real task with your provider
```

Or ask Claude to call `codex_info`.

## Tools

| Tool | What it does |
|---|---|
| `codex_run` | Start a task: `prompt`, plus optional `cwd`, `sandbox`, `session_id`, `model`, `wait_sec`, `timeout_sec`. Returns the result, or `status: running` with a `job_id`. |
| `codex_status` | Wait for a job and return its result. Without `job_id` it lists recent jobs. |
| `codex_cancel` | Stop a job and everything it started. |
| `codex_info` | Codex path, version, detected features and this server's settings. Uses no tokens. |
| `codex_output` | The **verbatim** output of a command Codex ran (test runs, scripts), taken from the event log, by number (`command`, negative counts from the end) or by `match`. Without either it lists the job's commands. No model involved; works after a server restart too. |
| `workspace_read` | Read files or list folders inside an allowed workspace directly: exact text with size, sha256 and BOM/CRLF flags. No tokens. |
| `workspace_write` | Write files inside an allowed workspace byte for byte (utf8 or base64, optional expected `sha256`, `overwrite` off by default, never inside `.git`). For seeding projects, acceptance scripts and test data. On by default only when `CODEX_MCP_ALLOWED_ROOTS` is set. |

These three exist so the client can verify Codex's work without trusting Codex to retype anything: put the acceptance script in with `workspace_write`, have Codex run it, read the real output with `codex_output`, and review changed files with `workspace_read`.

Example result:

```
Implemented retry with backoff in src/http.ts and added tests; npm test passes.

---
status: completed | job_id: j_mbx2k1a3f9 | session_id: 019a5c3e-…
duration: 2m14s | commands: 6 | files changed: 2 | codex tokens: in 48210 (cached 31000) / out 2210
files:
  M src/http.ts
  A test/http.test.ts
commands; verbatim output via codex_output job_id "j_mbx2k1a3f9" command N:
  #5 exit 1 $ npm test
  #6 exit 0 $ npm test
To continue this Codex conversation, call codex_run with session_id "019a5c3e-…".
```

Pass the latest `session_id` to continue the same Codex conversation (`codex exec resume`).

## Configuration

All settings are environment variables in the client's `env` block. `install` writes the common ones for you.

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_MCP_DEFAULT_CWD` | server's working directory | Folder used when a call gives no `cwd`. |
| `CODEX_MCP_ALLOWED_ROOTS` | *(any)* | Folders `cwd` must be inside (`;` on Windows, `:` elsewhere). The filesystem root, your home folder and the Windows system folder are always refused. |
| `CODEX_MCP_LEAN` | `0` | `1` turns off Codex plugins and the MCP servers in `~/.codex/config.toml` for these runs only. See [Saving tokens](#saving-tokens). |
| `CODEX_MCP_LEAN_KEEP` | | Comma-separated MCP server names to keep in lean mode. |
| `CODEX_MCP_DEFAULT_SANDBOX` | `workspace-write` | `read-only`, `workspace-write` or `danger-full-access`. |
| `CODEX_MCP_ALLOW_DANGER` | `0` | Must be `1` before `danger-full-access` can be used. |
| `CODEX_MCP_WINDOWS_SANDBOX` | *(Codex config)* | Windows: `unelevated`, `elevated` or `mxc`, passed as `-c windows.sandbox=…`. |
| `CODEX_MCP_DEFAULT_MODEL` | *(Codex config)* | Model passed as `--model`. |
| `CODEX_MCP_EXTRA_ARGS` | `[]` | JSON array of extra `codex exec` arguments, e.g. `["-c","model_reasoning_effort=high"]`. |
| `CODEX_MCP_CODEX_PATH` | found on `PATH` | Full path to `codex`, `codex.cmd`, `codex.exe` or Codex's `codex.js`. |
| `CODEX_MCP_RUN_WAIT_SEC` / `CODEX_MCP_STATUS_WAIT_SEC` | `45` | How long one `codex_run` / `codex_status` call waits. |
| `CODEX_MCP_TIMEOUT_SEC` | `1800` | Hard limit per Codex run. |
| `CODEX_MCP_MAX_CONCURRENT` | `4` | Codex jobs running at once. |
| `CODEX_MCP_MAX_OUTPUT_CHARS` | `20000` | Longer final messages are truncated (the full text stays in the log folder). |
| `CODEX_MCP_FILE_TOOLS` | `readwrite` with allowed roots, else `read` | `off`, `read` (only `workspace_read`) or `readwrite` (also `workspace_write`). Both stay inside the same folders `cwd` may use. |
| `CODEX_MCP_SNAPSHOT_MAX_FILES` | `20000` | Workspace snapshot used to list files changed by shell commands. Skips `.git`, `node_modules`, build folders. `0` turns it off. |
| `CODEX_MCP_SKIP_GIT_REPO_CHECK` | `1` | Lets Codex work outside git repositories. |
| `CODEX_MCP_LOG_DIR` / `CODEX_MCP_LOG_RETENTION_DAYS` | `<tmp>/codex-exec-mcp` / `7` | Per-job logs (prompt, events, stderr, final message). |

## Saving tokens

Codex sends its whole context with every model request, so a task of N steps costs about N × context. Two things inflate the context:

- **Tool definitions** from MCP servers and plugins. Models marked `supports_search_tool = true` in Codex's model catalog load them on demand. Other models, including many third-party models added through a custom `models.json`, receive *every* definition in *every* request.
- **Plugin skills and hooks**, which add instructions to every request.

A coding sub-agent rarely needs your data MCP servers or browser plugins. With `CODEX_MCP_LEAN=1`, each run gets `-c features.plugins=false` plus `-c mcp_servers.<name>.enabled=false` for every server in `~/.codex/config.toml`. Your config file is only read, and Codex used directly is unaffected. `codex_info` lists what lean mode disables.

Other levers: keep tasks scoped, ask Codex for a short final report, and use a lower reasoning effort for routine work.

## Windows notes

- **Sandbox.** Codex enforces `--sandbox` on native Windows only when `[windows] sandbox` is set, either in Codex's config or with `CODEX_MCP_WINDOWS_SANDBOX` / `install --windows-sandbox`.
  - `elevated` runs commands as a separate `codexsandbox*` account. That account cannot read tools installed per-user under AppData (for example a "just for me" Python install), so `python` is not found.
  - `unelevated` runs as your own account with a restricted token. Your tools work, and writes are still limited to the project folder.
- **Python temp dirs.** Inside the sandbox, `tempfile.mkdtemp()` creates folders that the sandboxed process cannot write into or delete. Tests that use `tempfile` fail. Ask Codex to create test folders with `os.makedirs` inside the project instead; the bundled skill does this. Leftover `tmp*` folders can be deleted from your normal account.
- If Claude Desktop cannot find `node` or `codex`, run `install` (it writes absolute paths) or set `CODEX_MCP_CODEX_PATH`.

## Troubleshooting

1. `codex-exec-mcp doctor --live` prints the error and Codex's stderr.
2. Failed runs include Codex's stderr and the log folder. Provider errors (401, wrong `base_url`, missing API key variable) show up there.
3. Claude Desktop logs: `%APPDATA%\Claude\logs\mcp-server-codex.log` (Windows; MSIX-packaged install: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\logs\`), `~/Library/Logs/Claude/mcp-server-codex.log` (macOS).
5. MSIX-packaged install on Windows (check with `Get-AppxPackage *Claude*`): the app reads its config from `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`, not `%APPDATA%\Claude\`. `install` picks the right file automatically; when editing by hand, use Settings → Developer → Edit Config.
4. If your Codex provider uses `env_key`, that variable must be visible to this server: set it system-wide or in `env`.

## Security

Codex is an autonomous agent that edits files and runs commands. This server limits *where* it runs (`cwd` checks, allowed roots) and passes the sandbox you choose. The isolation itself comes from Codex's sandbox. Keep `workspace-write` or `read-only`, set allowed roots, and use it only on projects you trust. `danger-full-access` stays off unless you opt in.

## How it works

```
Claude ──MCP stdio──▶ codex-exec-mcp ──▶ codex exec --json --cd DIR --sandbox MODE -o last.txt [-c …lean] [resume ID] -
                            ▲                    │  prompt on stdin, JSONL events on stdout
                            └── summary + reply ◀┘
```

## Development

```bash
npm test                      # 51 tests against a fake Codex; no network or API key
claude plugin validate .      # plugin + marketplace manifests
```

`test/fixtures/fake-codex.mjs` mimics the Codex CLI. Markers in the prompt (`[sleep:500]`, `[fail]`, `[hang]`, `[tree]`, `[touch:f]`, …) choose its behaviour. CI runs on Linux, macOS and Windows with Node 18–24. Please keep the zero-dependency rule.

## License

MIT
