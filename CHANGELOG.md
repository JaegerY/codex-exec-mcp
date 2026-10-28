# Changelog

## 1.1.0

Based on a real delegation test (seed a buggy project, have Codex fix it, verify independently), where every file moved in or out had to be retyped by a model and one 7 KB acceptance script could not be reproduced exactly after 60 commands and 2.4M input tokens.

- **`codex_output`:** returns the verbatim output of any command Codex ran in a job, by number or `match`, from memory or from the job's `events.jsonl` after a restart. Finished results now end with the last three commands (number, exit code, command with the PowerShell/bash wrapper removed).
- **`workspace_read` / `workspace_write`:** read and write files inside the allowed workspace directly, with sizes and sha256, no model involved. Paths are resolved through symlinks and must stay inside `cwd`; `.git` is never written; a call writes nothing if any entry is invalid. `CODEX_MCP_FILE_TOOLS` = `off` | `read` | `readwrite`; writing is on by default only when `CODEX_MCP_ALLOWED_ROOTS` is set.
- **Change list shows net changes:** a file Codex created with a patch and later deleted (or restored) is no longer listed as added.
- The server instructions and the `codex-delegate` skill now use these tools for seeding and verification.
- `codex-delegate` skill: new Windows trap — tell Codex to use PowerShell, because its first attempts with `bash.exe` (WSL) fail with `E_ACCESSDENIED` on machines without WSL and waste a step each.

## 1.0.0

- **One-command install for Claude Desktop:** `codex-exec-mcp install [--root DIR] [--windows-sandbox MODE] [--no-lean]` and `uninstall`. Backs up the config, changes only the `mcpServers` entry, and writes absolute node and script paths. Finds the virtualised config of MSIX-packaged installs (Store, WinGet, packaged installers) under `%LOCALAPPDATA%\Packages\Claude_*`.
- **Claude Code plugin and marketplace:** the repository is a plugin (`codex-exec`) that ships the MCP server (lean mode on) and the `codex-delegate` workflow skill (spec → delegate → independent verification → fix loop).
- **Breaking:** the executable moved from `bin/` to `cli/` (a plugin's `bin/` folder has a special meaning). Re-run `install`, or update the path in your client config.
- Unknown command-line arguments are rejected instead of starting the server.
- Internal clean-ups; documentation rewritten around the three install paths.

## 0.2.0

- Lean mode (`CODEX_MCP_LEAN=1`, `CODEX_MCP_LEAN_KEEP`): turns off Codex plugins and the MCP servers from `~/.codex/config.toml` for sub-agent runs only, using `-c` overrides. The Codex config is read, never written. This cuts per-request context sharply for models without on-demand tool loading.
- Files changed by shell commands are now listed. A bounded before/after workspace snapshot (`CODEX_MCP_SNAPSHOT_MAX_FILES`, default 20000) is merged with Codex's own patch edits, and the snapshot decides add/modify/delete.
- Changed files are shown relative to `cwd`.
- `codex_info` reports lean mode and change tracking.

## 0.1.0

First release.

- Tools: `codex_run`, `codex_status`, `codex_cancel`, `codex_info`.
- Zero-dependency MCP server over stdio. Supports both eras: legacy `initialize` (2024-11-05 to 2025-11-25) and the stateless 2026-07-28 protocol with `server/discover`.
- Wraps `codex exec --json`. Flags are detected at runtime, and older Codex builds without `--json` still work.
- Hybrid blocking: returns a `job_id` before client timeouts are reached, with progress notifications while waiting.
- Session continuation through `codex exec resume`.
- Kills the whole process tree on cancel, timeout or client disconnect.
- Guard rails: allowed roots, refusal of root, home and system directories, opt-in `danger-full-access`, and the `CODEX_MCP_WINDOWS_SANDBOX` option.
- `doctor` / `doctor --live` command for setup checks.
