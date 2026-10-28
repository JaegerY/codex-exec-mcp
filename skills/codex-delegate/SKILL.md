---
name: codex-delegate
description: Use when the user wants a coding task handed to Codex through the codex-exec-mcp tools (codex_run / codex_status), e.g. "let Codex do it" or "交给 Codex": write a spec, delegate, verify independently, iterate.
---

# Delegate coding work to Codex, then verify it yourself

Codex runs on the user's machine with the user's own model provider. Codex does the implementation. You do the parts that are hard to check afterwards: the spec, the acceptance criteria and the review. Never accept Codex's own "all tests pass" without checking.

## 0. Check the setup
- Call `codex_info` once per conversation. It shows the Codex version, the default and allowed folders, the sandbox, and whether lean mode is on.
- If Codex is not found or a setting is wrong, tell the user what to change (README → Configuration) instead of working around it.
- The project folder must be inside the allowed roots. Always pass it as an absolute `cwd`.
- Note the `file tools` line: `readwrite` gives you `workspace_read` + `workspace_write`, `read` only `workspace_read`. `codex_output` is always there.

## Moving files in and out: never ask Codex to retype them
Codex's final message is written by a model. Anything you ask it to copy (a file's content, base64, a script, a test log) can come back changed, and checking it costs many steps and tokens.
- **Into the workspace** (a seed project, test data, your acceptance script): `workspace_write`. It writes the bytes exactly and returns each file's sha256. Pass `overwrite: true` only when replacing on purpose.
- **Out of the workspace** (changed source, result files): `workspace_read`. It returns the text verbatim with size and sha256, and flags BOM and CRLF.
- **Command output** (test runs, your acceptance script): `codex_output` with the `job_id` and `match` (e.g. `"unittest"`) or `command` (`-1` = last). Without either it lists the commands.
- If file tools are off or `read` only, say so to the user and suggest `CODEX_MCP_FILE_TOOLS=readwrite` (README → Configuration) instead of working around it with transcription.

## 1. Write the spec (quality comes from here)
Write one self-contained brief. Codex cannot see this conversation. Include:
- Where to work (a sub-folder if it is a new project), the language and runtime version, and which dependencies are allowed.
- The file layout.
- Exact behaviour: inputs, outputs, formats, error messages, exit codes, sort and tie rules, rounding. Write formats literally (for example `warning: line N: <reason>`). Exact strings are what make independent verification possible.
- The tests Codex must write, and the exact command to run them.
- The final report you want back: at most ~10 lines, covering files changed, the final test summary line, and any spec ambiguity and how it was resolved. Short replies keep your own context small.
- Constraints such as "work only inside X" and "do not install anything", plus the environment traps below that apply.

## 2. Delegate
- Call `codex_run` with `prompt`, `cwd`, `sandbox: "workspace-write"` (`"read-only"` for reviews and investigations) and `wait_sec: 55`.
- On `status: running`, call `codex_status` with the `job_id` and `wait_sec: 55` until it finishes. Do not poll with short waits.
- A few quiet minutes before the first action are normal at high reasoning effort. If nothing has happened after about 8 minutes, check `codex_output` (it also works while the job runs) before cancelling.
- Tell the user in one line when the job starts and when it finishes. Do not narrate each poll.

## 3. Verify independently (never skip)
- Read the changed files listed in the result with `workspace_read`.
- Do not take the test result from Codex's summary. Read the real output of its test run with `codex_output` (`match` on the test command), or ask Codex to run the tests once more and read that.
- Write a separate acceptance check **from the spec alone**, put it outside the project with `workspace_write` (e.g. `<root>/accept/accept.py`, so it cannot be "fixed" along with the code), ask Codex in a fresh session to run exactly that one command and change nothing, then read the output with `codex_output`. A useful acceptance script prints one PASS/FAIL line per check and a final `ACCEPT n/m` line.
- Target what Codex's own tests usually miss: realistic bad input (wrong encoding such as GBK CSVs from Excel, missing files or columns), exact output formats, sort and tie rules, exit codes, output encoding, and whether running the tests leaves junk files behind.
- If you can run code yourself, you can also bring the sources over with `workspace_read` and run the check locally.
- Read the source for spec violations and bad practice, such as global monkeypatching, swallowed errors and duplicated helpers.
- Report the pass/fail count, with a concrete reproduction for each defect.

## 4. Iterate in the same Codex session
- Call `codex_run` with the **latest** `session_id` from the previous result. A resumed run can return a new id; always use the newest one.
- For each defect, list what happens, what is required, and which test to add. Ask for the same short report.
- Re-run your acceptance check. Accept small deviations that match what you asked for, and do not spend a round on cosmetics.

## 5. Close out
Tell the user:
- what was built and where;
- the verification result (Codex's suite plus your acceptance check, N/N);
- the defects found and fixed;
- the cost: Codex tokens and cache share from the result footer, plus wall time;
- any leftovers they must clean up by hand (including your acceptance folder);
- one next step.

## Environment traps
- **Windows, Python temp dirs:** in Codex's Windows sandbox, `tempfile.mkdtemp()` and `TemporaryDirectory()` create directories that the sandboxed process can create but cannot write into or delete. Tell Codex up front: "in tests, do not use tempfile; create temp dirs with os.makedirs under `<project>/.test-tmp/` through one shared helper, and gitignore it". Stuck `tmp*` folders can only be removed by the user's normal account.
- **Windows, elevated sandbox:** commands run as a separate `codexsandbox*` account that cannot read tools installed per-user in AppData (Python, uv). The `unelevated` sandbox (`CODEX_MCP_WINDOWS_SANDBOX=unelevated`) avoids this.
- **Windows, shell:** Codex often tries `bash.exe` first, which is WSL's launcher; without a usable WSL distribution every such command fails (`Bash/Service/CreateInstance/E_ACCESSDENIED`) and is retried in PowerShell, wasting a step each time. On Windows, tell Codex up front: "use PowerShell for shell commands; do not use bash.exe or WSL".
- **Writes outside `cwd` are denied** under `workspace-write`, including the system temp folder. The sandbox also has no network access, so tell Codex not to download dependencies.
- **Token cost** grows with the number of steps × the context size. Keep lean mode on, keep tasks scoped, and ask for short replies.
