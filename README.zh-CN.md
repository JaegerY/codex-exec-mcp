# codex-exec-mcp

[English](README.md)

让 Claude（Claude Desktop、Claude Code）或任何 MCP 客户端，把编程任务交给 [Codex CLI](https://github.com/openai/codex) 作为子代理完成。

Codex 运行时用的是**你自己的 Codex 配置**：你在 `~/.codex/config.toml` 里配的是哪个模型服务商（OpenAI、DeepSeek、本地模型……），实际干活的就是哪个。典型用法：Claude 负责写需求说明和验收，Codex 负责写代码，这样 Claude 的额度能撑得更久。

- **零依赖**：纯 Node.js，MCP 协议直接手写，不会因为 SDK 升级而崩。
- **新旧 MCP 客户端都支持**：支持旧版 `initialize` 握手（2024-11-05 到 2025-11-25），也支持 2026-07-28 版的无状态协议和 `server/discover`。响应格式经过官方 JSON Schema 校验。
- **不怕 Codex 升级**：调用官方文档化的 `codex exec --json`，不依赖已删除的 `codex mcp-server`，也不依赖实验性的 app-server。参数在运行时自动检测。
- **不受客户端超时限制**：`codex_run` 最多等 45 秒，还没完成就返回 `job_id`，再用 `codex_status` 接着等。长任务也不会撞上 60 秒的工具调用上限。
- **返回内容精简**：Claude 只收到 Codex 的最终回复和改动摘要（文件、命令、token 用量），不会收到完整过程。Codex 用命令行改动的文件也会列出来。
- **精简模式**：只在子代理运行时关掉 Codex 插件和你配置的 MCP 服务器。有一次实测，每次请求的上下文从约 11.8 万 token 降到约 1.4 万。
- **进程清理干净**：取消、超时或客户端退出时，会结束 Codex 及它启动的所有进程。支持 Windows、macOS、Linux。

## 环境要求

- Node.js 18.17 或更高
- Codex CLI（`npm i -g @openai/codex`）。先在终端确认 `codex exec "say hi"` 能正常运行。

## 安装

### Claude Code：插件（包含 MCP 服务器和工作流技能）

```text
/plugin marketplace add JaegerY/codex-exec-mcp
/plugin install codex-exec@codex-exec-mcp
```

插件启动服务器时默认开启精简模式，并附带 `codex-delegate` 技能。你说"让 Codex 实现……"时，Claude 会写需求说明、交给 Codex、独立验收结果，并把发现的问题退回 Codex 修改。

### Claude Desktop：一条命令

```bash
npm i -g codex-exec-mcp
codex-exec-mcp install --root /你的/项目/目录
# Windows 示例：
codex-exec-mcp install --root C:\Users\你的用户名\projects --windows-sandbox unelevated
```

这条命令会在 Claude Desktop 的配置里写入 `mcpServers.codex` 这一项（以 MSIX 应用包形式安装的版本，比如商店、WinGet 或打包安装程序装的，配置在 `%LOCALAPPDATA%\Packages\Claude_*` 下，也能自动找到）：写之前先备份，其他内容一概不动；用的是绝对路径，不会因为 PATH 的问题启动失败。重复运行会更新这一项。完成后从托盘完全退出 Claude Desktop，再重新打开。卸载用 `codex-exec-mcp uninstall`。

| `install` 参数 | 说明 |
|---|---|
| `--root 目录`（可重复） | Codex 可以工作的目录，第一个作为默认目录。强烈建议设置。 |
| `--windows-sandbox unelevated` | Windows：用你自己的账户在沙箱里执行命令，见 [Windows 说明](#windows-说明)。 |
| `--no-lean` | 不开精简模式，子代理仍可使用你的 Codex 插件和 MCP 服务器。 |
| `--name 名字`、`--config 文件`、`--dry-run` | 配置项名称（默认 `codex`）、指定其他配置文件、只预览不写入。 |

还没发布到 npm 时：克隆仓库，在仓库目录里运行 `node cli/codex-exec-mcp.js install …`。

想在 Claude Desktop 里也用这套工作流，把 `skills/codex-delegate/SKILL.md` 添加为技能即可。

### 其他 MCP 客户端（Cursor、Windsurf、VS Code 等）

命令填 `node`，参数填 `/绝对路径/codex-exec-mcp/cli/codex-exec-mcp.js`，配置项写在 `env` 里（见[配置项](#配置项)）。

### 检查是否装好

```bash
codex-exec-mcp doctor          # 查找 Codex、显示检测到的功能，不消耗 token
codex-exec-mcp doctor --live   # 额外用你的服务商实际跑一个很小的任务
```

也可以让 Claude 调用 `codex_info`。

## 工具

| 工具 | 作用 |
|---|---|
| `codex_run` | 启动任务：`prompt`，可选 `cwd`、`sandbox`、`session_id`、`model`、`wait_sec`、`timeout_sec`。完成就返回结果，否则返回 `status: running` 和 `job_id`。 |
| `codex_status` | 等待任务完成并返回结果；不传 `job_id` 时列出最近的任务。 |
| `codex_cancel` | 停止任务及它启动的所有进程。 |
| `codex_info` | 显示 Codex 路径、版本、检测到的功能和本服务器配置，不消耗 token。 |
| `codex_output` | 从事件日志里**逐字**取出 Codex 跑过的某条命令的输出（测试、脚本），按序号（`command`，负数从末尾数）或关键字（`match`）选；都不传时列出该任务的全部命令。不经过模型，服务器重启后也能读。 |
| `workspace_read` | 直接读取允许目录内的文件或列出文件夹：原样文本，附大小、sha256 和 BOM/CRLF 标记。不消耗 token。 |
| `workspace_write` | 直接按字节写入允许目录内的文件（utf8 或 base64，可校验预期 `sha256`，默认不覆盖，拒绝写入 `.git`）。用来放种子项目、验收脚本和测试数据。只有设置了 `CODEX_MCP_ALLOWED_ROOTS` 时默认开启。 |

这三个工具让调用方验证 Codex 的工作时不必依赖它转抄：用 `workspace_write` 放入验收脚本，让 Codex 运行，用 `codex_output` 读真实输出，用 `workspace_read` 审查改动的文件。

传入最新的 `session_id`，可以继续同一个 Codex 会话（`codex exec resume`）。

## 配置项

全部通过客户端配置的 `env` 设置，常用的几项 `install` 会自动写好。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_MCP_DEFAULT_CWD` | 服务器启动目录 | 调用时没传 `cwd` 就用这个目录。 |
| `CODEX_MCP_ALLOWED_ROOTS` | 不限制 | `cwd` 必须位于这些目录之内（Windows 用 `;` 分隔，其他系统用 `:`）。根目录、用户主目录和 Windows 系统目录始终会被拒绝。 |
| `CODEX_MCP_LEAN` | `0` | 设为 `1` 后，只对本服务器发起的任务关闭 Codex 插件和 `~/.codex/config.toml` 里的 MCP 服务器。见[节省 token](#节省-token)。 |
| `CODEX_MCP_LEAN_KEEP` | | 精简模式下仍要保留的 MCP 服务器名，多个用英文逗号分隔。 |
| `CODEX_MCP_DEFAULT_SANDBOX` | `workspace-write` | 可选 `read-only`、`workspace-write`、`danger-full-access`。 |
| `CODEX_MCP_ALLOW_DANGER` | `0` | 设为 `1` 才允许使用 `danger-full-access`。 |
| `CODEX_MCP_WINDOWS_SANDBOX` | 用 Codex 配置 | 仅 Windows：`unelevated`、`elevated` 或 `mxc`，以 `-c windows.sandbox=…` 传入。 |
| `CODEX_MCP_DEFAULT_MODEL` | 用 Codex 配置 | 通过 `--model` 指定模型。 |
| `CODEX_MCP_EXTRA_ARGS` | `[]` | 额外传给 `codex exec` 的参数，写成 JSON 数组，例如 `["-c","model_reasoning_effort=high"]`。 |
| `CODEX_MCP_CODEX_PATH` | 从 PATH 查找 | `codex`、`codex.cmd`、`codex.exe` 或 Codex 的 `codex.js` 的完整路径。 |
| `CODEX_MCP_RUN_WAIT_SEC` / `CODEX_MCP_STATUS_WAIT_SEC` | `45` | 每次调用 `codex_run` / `codex_status` 最多等待的秒数。 |
| `CODEX_MCP_TIMEOUT_SEC` | `1800` | 单个任务的最长运行时间。 |
| `CODEX_MCP_MAX_CONCURRENT` | `4` | 最多同时运行的任务数。 |
| `CODEX_MCP_MAX_OUTPUT_CHARS` | `20000` | 最终回复超过这个长度会被截断，完整内容保留在日志目录里。 |
| `CODEX_MCP_FILE_TOOLS` | 设了允许目录时为 `readwrite`，否则 `read` | `off`、`read`（只有 `workspace_read`）或 `readwrite`（再加 `workspace_write`）。两者只能访问 `cwd` 允许的那些目录。 |
| `CODEX_MCP_SNAPSHOT_MAX_FILES` | `20000` | 用来统计命令行改动的目录快照上限，会跳过 `.git`、`node_modules` 和构建目录。设为 `0` 关闭。 |
| `CODEX_MCP_SKIP_GIT_REPO_CHECK` | `1` | 允许 Codex 在非 git 目录中工作。 |
| `CODEX_MCP_LOG_DIR` / `CODEX_MCP_LOG_RETENTION_DAYS` | `<临时目录>/codex-exec-mcp` / `7` | 每个任务的日志（提示词、事件、stderr、最终回复）。 |

## 节省 token

Codex 每次请求模型都会把完整上下文发一遍，所以一个 N 步的任务，开销大约是 N × 上下文大小。上下文变大主要有两个原因：

- **MCP 服务器和插件的工具说明。**在 Codex 模型列表里标了 `supports_search_tool = true` 的模型，会在用到时才加载这些说明；其他模型（包括很多通过自定义 `models.json` 接入的第三方模型）**每次请求都会带上全部工具说明**。
- **插件带的技能说明和 hooks**，每次请求也会附带。

子代理写代码时，一般用不到你的数据类 MCP 服务器和浏览器插件。设置 `CODEX_MCP_LEAN=1` 后，每次运行会带上 `-c features.plugins=false`，并对 `~/.codex/config.toml` 里的每个服务器加上 `-c mcp_servers.<名字>.enabled=false`。你的配置文件只读不改，直接使用 Codex 时也不受影响。`codex_info` 会列出精简模式关掉了哪些服务器。

其他省 token 的办法：任务范围尽量小，让 Codex 最后只给简短汇报，日常任务用较低的思考强度。

## Windows 说明

- **沙箱。**在原生 Windows 上，只有设置了 `[windows] sandbox`，Codex 才会真正执行 `--sandbox` 的限制。可以在 Codex 配置里设置，也可以用 `CODEX_MCP_WINDOWS_SANDBOX` 或 `install --windows-sandbox` 设置。
  - `elevated`：命令以单独的 `codexsandbox*` 账户运行。这个账户读不到装在你 AppData 里的工具（比如"仅为我安装"的 Python），所以会提示找不到 `python`。
  - `unelevated`：用你自己的账户加受限令牌运行。你装的工具都能用，写入仍然只限项目目录。
- **Python 临时目录。**在沙箱里，`tempfile.mkdtemp()` 建出的目录，沙箱进程既写不进去也删不掉，所以用了 `tempfile` 的测试会失败。应该让 Codex 在项目里用 `os.makedirs` 建测试目录，附带的技能会自动这样要求。遗留的 `tmp*` 目录可以用你自己的账户删除。
- 如果 Claude Desktop 找不到 `node` 或 `codex`，运行 `install`（它会写入绝对路径），或者设置 `CODEX_MCP_CODEX_PATH`。

## 排查问题

1. 运行 `codex-exec-mcp doctor --live`，失败时会打印错误信息和 Codex 的 stderr。
2. 任务失败时，结果里会附带 Codex 的 stderr 和日志目录。服务商相关的错误（401、`base_url` 写错、缺少 API key 环境变量）都会显示在那里。
3. Claude Desktop 的日志：`%APPDATA%\Claude\logs\mcp-server-codex.log`（Windows；MSIX 安装的版本在 `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\logs\`），`~/Library/Logs/Claude/mcp-server-codex.log`（macOS）。
5. Windows 上以 MSIX 应用包形式安装的版本（可用 `Get-AppxPackage *Claude*` 确认）：App 读取的配置文件是 `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`，不是 `%APPDATA%\Claude\` 下的那份。`install` 会自动选对文件；如果要手动修改，请通过 设置 → 开发者 → 编辑配置 打开。
4. 如果你的 Codex 服务商配置用了 `env_key`，对应的环境变量必须对本服务器可见：设成系统环境变量，或者写进 `env`。

## 安全

Codex 是一个会自主修改文件、执行命令的代理。本服务器能限制它在**哪里**运行（`cwd` 检查、允许目录列表），并把你选择的沙箱模式传给它，但真正的隔离依赖 Codex 自己的沙箱。建议保持 `workspace-write` 或 `read-only`，设置允许目录，只在你信任的项目里使用。`danger-full-access` 默认禁用，需要你主动开启。

## 开发

```bash
npm test                      # 51 个测试，使用模拟的 Codex，不需要网络或 API key
claude plugin validate .      # 校验插件和插件市场的配置文件
```

`test/fixtures/fake-codex.mjs` 模拟了 Codex CLI，通过提示词里的标记控制行为（`[sleep:500]`、`[fail]`、`[hang]`、`[tree]`、`[touch:f]` 等）。CI 会在 Linux、macOS、Windows 上，用 Node 18 到 24 运行全部测试。欢迎贡献代码，请保持零依赖。

## 许可证

MIT
