# pi-kit

个人 [Pi](https://pi.dev) 配置包：安全、SSH 与工作流扩展。

- **Safety Guard**：阻止灾难性删除和 WSL/Linux 对 Windows 挂载路径的写入；通过主题化选择框确认删除、依赖变更、Git 写操作及系统级命令
- **Sensitive Paths**：阻止直接修改 Git 元数据和私钥，并在写入环境变量、凭据及 secrets 文件前确认
- **SSH Remote**：按需将 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 和 `!` 命令路由到 SSH 服务器
- **Exa Search**：通过本地只读 `exa_search` 工具检索最新网页信息，在 SSH 与 Review 模式下仍可使用
- **Tokyo Night Theme**：统一原生对话、Handoff、工具区域、Markdown、输入框与扩展界面的配色
- **Compact Tools**：Bash / Read / Edit / Write / Exa Search 紧凑彩色展示，折叠命令、文件预览、diff 与搜索详情；仅修改渲染，不替换执行器（已验证 Pi 1.4.0）
- **Custom Footer**：突出显示本地/SSH 目标、Git 分支、模型、思考等级和上下文用量，并支持独立配色
- **Presets**：提供严格只读的 `review` 工作流，统一限制工具、Shell 命令和提示指令
- **Verification**：登记验收命令，记录真实工具退出码和执行环境，修改后使旧证据过期，不自动执行或续跑
- **Handoff**：将长会话压缩为可编辑的新会话启动提示
- **Dirty Repo Guard**：在切换、Fork 或 Clone 会话前检查本地 Git 工作区；SSH 模式直接跳过
- **Titlebar Spinner**：Agent 工作时在终端标题显示动画和当前目标
- **AGENTS.md**：可选的个人开发规范

## 安装

当前开发分支以 **Pi 0.99.2 / Node.js 24** 为验证基线，Pi 开发依赖固定为 0.99.2；不保证旧版 Pi 兼容。宿主提供的包按官方约定保留 `peerDependencies: "*"`，不作为运行时依赖重复安装。

本地目录：

```bash
pi install /absolute/path/to/pi-kit
```

GitHub（建议固定版本）：

```bash
pi install git:github.com/AstraNoctis03/pi-kit@v0.2.0
```

临时测试：

```bash
pi --no-extensions --no-skills \
  -e ./extensions/safety-guard/index.ts
```

## Safety Guard

直接阻止：

- 独立的 `powershell` 工具（尚无 PowerShell 安全策略，统一阻止；改用受保护的 `bash`）
- `rm -rf /` 和递归删除 home
- 在 WSL/Linux 中通过工具或 Shell 写入 `/mnt/c`、`/mnt/d`、`C:\`、`D:\`

要求确认（交互终端显示“确认 / 取消”；选中取消后可按 Tab 输入拒绝反馈）：

- 删除文件或目录
- 安装、卸载或更新依赖
- Git 写操作
- `sudo`、递归权限变更、系统服务、关机、重启、格式化及 `dd of=...`

普通文件编辑、测试、lint、build、Git 只读命令，以及原生 Windows 中的项目文件修改不会触发确认。

Safety Guard、Sensitive Paths 和 Dirty Repo Guard 在 TUI 中共享无整块底色、随终端宽度自适应的确认框，会话认领也采用相同样式。标题嵌入铺满可用宽度的细分隔线，不再绘制底边框；命令复用原生 Shell 高亮，路径使用青色强调。超大命令仅跳过着色，仍完整显示。完整命令、路径和风险原因自动换行，不使用工具预览式折叠；控制字符与双向显示控制符以可见转义展示，不丢弃其中的操作文本。操作提示以 `↑↓`、`Enter`、`Esc` 等简短形式显示当前主绑定，自定义绑定同步更新，其他快捷键别名仍然有效。默认仍选中确认（原 `Yes`），取消、拒绝反馈及授权范围不变；会话认领保持简单确认，不新增反馈步骤。RPC 仍使用原生确认接口，无 UI 时继续拒绝。

默认使用低亮度橙色分隔线、金色标题和柔和金色选中项；选中项不加粗，通过箭头和颜色标识，与青色路径区分。颜色仍可配置，正文使用 Pi Theme 以保证可读性。此统一不接管宿主设置选择器或第三方插件弹窗。配置文件：

```text
~/.pi/agent/confirmation-colors.json
```

支持 `#RRGGBB` 与 0–255 色号，字段可以只写需要覆盖的部分：

```json
{
  "border": "#b8754b",
  "title": "#e0af68",
  "selected": "#d5b778"
}
```

无效字段会回退到默认色；无效 JSON 会显示警告并整体使用默认色。修改后执行 Pi 内置 `/reload`。

Safety Guard 只是减少误操作的 guardrail，不是 Shell 解析器或安全沙箱。脚本、解释器和编码命令可能绕过静态规则；高风险场景仍应使用容器、最小权限、备份和版本控制。

## Sensitive Paths

默认规则：

- 阻止 `write` / `edit` 修改 `.git/`、`*.pem`、`*.key`、`*.p12`、`*.pfx` 和常见 SSH 私钥
- 写入 `.env`、credentials、secret / secrets 文件前要求确认
- 确认时使用与 Safety Guard 一致的主题化对话框；选中 `No` 后可按 Tab 输入反馈
- 允许 `.env.example`、`.env.sample`、`.env.template`

使用 `/sensitive-paths` 查看规则来源，修改配置后运行 Pi 内置的 `/reload`。全局和项目配置分别为：

```text
~/.pi/agent/sensitive-paths.json
.pi/sensitive-paths.json
```

自定义规则会追加到默认规则；`allow` 优先级最高，可用于覆盖默认保护：

```json
{
  "allow": ["**/fixtures/test.key"],
  "block": ["**/production/**"],
  "confirm": ["**/config/private.*"]
}
```

此扩展保护 Pi 的直接文件写入，不是文件系统权限或 Shell 沙箱；脚本和间接写入仍需依靠 Safety Guard、最小权限及版本控制。本地模式会解析现有符号链接及其已有父目录后再匹配规则；SSH 模式目前只检查传入的远程路径文本，远程符号链接仍应通过远端权限和版本控制防护。

## SSH Remote

使用 `~/.ssh/config` 中的别名启动远程模式：

```bash
pi --ssh mgt01d:/public/home/xjmao/project
pi --ssh s1d:/home/xjmao/project
```

省略路径时使用远程 SSH 登录后的默认目录：

```bash
pi --ssh mgt01d
```

远程模式会禁用 SSH 配置中的 `LocalForward`，避免并行工具调用争用本地转发端口。连接失败后工具会保持 fail-closed，不会退回本地执行。独立的 `powershell` 工具不属于 SSH 传输范围，在 SSH 模式始终阻止（即使未加载 Safety Guard），避免误执行本地命令。使用 `/ssh-status` 查看当前目标。

SSH 通过结构化提示的 `cwd` 与独立 `pi_kit_ssh` 章节标明远程目标，不再替换整段提示文本；保留其他扩展的指令，并明确 `exa_search` 仍在本机运行。

文件工具在进入 Pi 原生路径归一化之前按远端规则解释输入：相对路径基于远程工作目录、`../` 指向其父目录、`~/` 指向远程 home；Bash 和用户 `!` 命令也从远程工作目录启动。不会把本机启动目录当作远端目录，也不修改其他扩展看到的本地 `ctx.cwd`。远端路径使用独立的虚拟命名空间适配原生工具，避免与本机 home、启动目录或 Windows `/a/...` 盘符语法混淆；不会为此在本机创建目录。Windows 下以 `/` 开头的输入按远端 POSIX 路径解释，不会通过盘符解析命中本机 skill 例外。

用户另行加载的 Skill 仍由本机 Pi 管理。`read` 对当前已加载 skill 列表中的**入口文件**（例如本机 `~/.pi/agent/skills/example/SKILL.md`）使用受限的本地只读读取，不会把它们映射到服务器。其余文件读写、编辑、Shell 和搜索仍走 SSH；此例外不允许读取任意本地文件或整个 skill 目录，不执行本地脚本。入口文件丢失或读取期间符号链接目标改变时会报错，不会再尝试远程读取。额外的本地参考资料/脚本不在此例外内，需要另行处理，不能假定它们存在于远端。

新 Session 会独立记录执行环境与完整工作目录，并自动添加名称前缀，例如 `[LOCAL] 修复登录测试` 或 `[SSH compute-01:project] 修复登录测试`。SSH 使用远端短主机名识别服务器，`s1`、`s1d` 等连接别名不影响归属；探测失败时回退到别名。本地环境使用本机主机名区分。服务器应使用不同的主机名；改主机名会被视为环境改变。

### 按环境恢复会话

```text
/resume-env
```

默认显示**当前环境、所有目录下的未归档会话**，首次使用按「最近」平铺。Ctrl+S 只切换「最近／层级」，并持久记住排序偏好，重开列表、`/reload` 和重启后仍有效。层级模式保留 Parent/Fork/Handoff 的父子关系；父会话被环境或归档条件隐藏时，子会话独立显示。

按 Tab 循环切换「当前环境」「当前环境＋目录」「所有环境（含未知）」。输入关键词后自动使用原生模糊相关性排序，不再单独提供 relevance 模式；清空搜索恢复所选的最近／层级布局。Ctrl+P 显示会话文件路径，Ctrl+N 切换仅命名会话，Enter 恢复，Esc 取消。删除和改名仍使用原生 `/resume`。

归档操作在 `/resume-env` 列表中完成：

- **Alt+A**：归档或取消归档选中的单个会话。
- **Alt+H**：循环切换「未归档／已归档／含已归档」，仍保留当前环境筛选。
- **`/resume-env archived`**：直接打开当前环境的已归档会话。

归档不删除、不移动、不改写对话文件，也不会影响子会话的归档状态或父子关联。它不会关闭当前会话，恢复一个已归档会话也不会自动取消归档。归档只影响此扩展的列表，原生 `/resume` 仍能看到这些会话。

排序偏好为全局设置，归档按会话文件路径和 ID 识别；两者记录到 `<agent-dir>/resume-env-state.jsonl`（默认 `~/.pi/agent/resume-env-state.jsonl`）。这是独立的小型追加日志，不进入模型上下文；各 Pi 进程的更新不会通过整份配置覆盖彼此。状态损坏或保存失败会显示错误，不会静默清空归档。

选择器会立即显示，结果逐步加载。列表信息与环境信息合并为一次流式扫描，不再重复读取整段历史；同一运行期间缓存摘要，未改变的文件不重读，正常追加的会话只读取新增内容。缓存仅保存在内存中，`/reload` 或重启后的首次加载仍需扫描。搜索限于名称、最多 4096 字符的首条用户消息摘要、主机名和路径，不扫描完整对话正文。

Pi 不允许扩展直接覆盖内置 `/resume`，所以原生 `/resume` 和启动参数 `pi --resume` 的列表保持原样。扩展会检查原生会话切换：跨环境恢复会被取消，要求先以正确的本地/SSH 环境启动；启动时通过 `--session` / `--continue` 打开不匹配的会话，也不会改写归属，并阻止工具和 `!` 命令执行。恢复同一服务器的其他目录时，会验证并恢复该 Session 保存的远程工作目录，而不是沿用启动参数的目录。

名称不是环境依据。`/name` 只修改标题并保留原归属前缀，不会把会话转换成当前服务器的会话。

**旧会话不会凭名称或当前连接自动归类**，只出现在「所有环境」中。载入后可查看历史和归属：

```text
/session-env
/claim
```

确认历史确实属于当前环境后，用 `/claim` 显式认领，弹窗确认后记录当前环境与目录；旧写法 `/session-env claim` 继续兼容。在认领前，未知会话的工具与 `!` 命令被阻止；已记录的归属不能用此命令覆盖。建议先为当前旧会话完成认领，再继续工作。

要求：

- 已配置基于密钥或 Agent 的非交互 SSH 登录
- 远程系统提供 Bash、GNU `find`、`head` 和 GNU `grep`
- 文件写入另需 GNU coreutils：`realpath`、`stat`、`mktemp`、`cat`、`wc`、`sha256sum`、`cp`（支持 ACL/xattr）、`mv`、`rm`、`rmdir`；缺少能力时拒绝写入，不退回原地覆盖
- `grep` 优先使用远程 ripgrep（`rg`），未安装时自动回退到 GNU `grep`

GNU `grep` 回退与远程 `find` 会排除 `.git`、`node_modules`，但不会解析其他 `.gitignore` 规则。

### 写入中断保护

SSH `write` / `edit` 先将内容写入目标目录下的私有 `.pi-write-*` 临时目录，校验 UTF-8 字节长度和 SHA-256 后才原子替换；半截输入、校验失败或提交前错误不会截断原文件。不重试写入，也不自动降级。普通新文件遵循远端 umask；已有文件通过 GNU `cp` 的[属性复制选项](https://www.manpagez.com/info/coreutils/coreutils-9.3/cp_invocation.php)保留权限、所有者/组、ACL 和扩展属性，但不沿用旧修改时间。

- 符号链接会写入其实际目标，不替换链接本身；目标目录必须存在且可写。已有文件还需可读，以便 GNU `cp` 复制属性；不会为此临时放宽源文件权限。
- 原子替换无法保持硬链接的同 inode 语义，遇到硬链接、非普通文件、只读文件或无法保留属性时明确报错，不偷偷改变语义。
- 上传期间检查目标路径与文件元数据是否变化，但这不是多进程锁或完整的并发事务；不能防止所有外部编辑竞态。
- 如果远端已提交而连接在回执前断开，工具仍可能报错，此时文件可能已经是完整新版本；先重新读取确认，勿盲目重试。原子替换不保证断电持久性；强杀或主机故障可能遗留私有临时目录。

SSH 扩展不会建立安全沙箱。首次使用应选择测试目录，并确保远程数据有备份和最小权限保护；条件允许时也可使用 Git。

## Exa Search

`exa_search` 是固定访问 `https://api.exa.ai/search` 的本地只读工具，默认返回 5 条结果和相关 Highlights；支持 1–10 条结果、`auto` / `fast` / `instant` 模式、域名过滤、发布日期范围及内容新鲜度。即使 Pi 处于 SSH 模式，搜索请求仍从本机发出。

先在 [Exa Dashboard](https://dashboard.exa.ai/api-keys) 创建 API Key，并通过 Windows 用户环境变量设置：

```powershell
setx EXA_API_KEY "your-api-key"
```

设置后完全重启 Pi。工具不会打印 API Key，并会固定超时、清理控制字符、截断超大输出，同时返回 Exa 报告的单次请求费用。网页结果属于不可信外部输入，回答时应核对并引用返回的 URL。

Pi 1.4.0 使用独立的紧凑渲染：标题显示查询和耗时，正文显示真实结果数、已报告费用及前 3 条标题/来源。展开保留原始查询参数、全部已返回的摘要、日期和提示；错误正文与结果截断警告保持可见。只识别本工具既有的结果格式，无法识别的历史结果保守展示原文。搜索请求、返回文本、元数据、会话日志和模型上下文不变，渲染不会再次发请求；旧宿主保持原生工具显示。

## Presets

内置 `review` 工作流：

- 思考等级为 `high`
- 启用 `read`、`bash`、`grep`、`find`、`ls`、`exa_search`
- Bash 只允许 Git 只读、文件检查、测试、lint 和类型检查命令
- 阻止 Shell 重定向、命令链、文件修改、依赖变更和 Git 写操作
- `write` / `edit` / `powershell` 即使被其他配置重新启用也会被拦截；直接调用和经 `ctx.executeTool()` 嵌套调用遵循相同规则

Review 的 Bash 限制是静态白名单而非操作系统沙箱；已阻止已知输出文件、外部 helper、重定向和修复参数，但获准的项目测试脚本仍可能按项目自身逻辑生成缓存或构建产物。最终只读保证仍应结合只读工作区或容器。

使用方式：

```text
/preset review
/preset normal
```

`normal` 恢复启用 Review 前的模型、思考等级和完整工具；简单任务通过 `Shift+Tab` 调整思考强度，无需额外 Preset。Preset 指令使用独立的 `pi_kit_preset` 结构化提示章节，重复回合不会追加副本，切回 `normal` 后在下一次请求移除该章节，不覆盖 SSH 或其他扩展的提示。

也可在启动时指定：

```bash
pi --preset review
```

全局 `~/.pi/agent/presets.json` 与可信项目的 `.pi/presets.json` 可以覆盖 `review` 或新增自定义 Preset：

```json
{
  "research": {
    "thinkingLevel": "xhigh",
    "tools": ["read", "grep", "find", "ls"],
    "instructions": "Explore thoroughly and produce a concise evidence-based report."
  }
}
```

修改配置后执行 Pi 内置的 `/reload`。

## Verification

按会话显式登记验收命令：

```text
/verify add npm run validate
/verify add npm test
/verify
```

`add` **只登记，不执行，也不授予执行权限**。之后仍由 Agent 使用正常 `bash` 工具运行检查，经过原有守卫与 SSH 路由。记录只接受去除首尾空白后的完整命令匹配；登记 `npm test` 后，`cd other && npm test` 不会被当作同一次验收。

`/verify` 显示未运行、运行中、通过、失败、已过期或结果未知，以及会话环境、完成时间、工具调用 ID 和结构化退出码。只有退出码明确为 0 且工具未报错才算通过，不解析输出中的“tests passed”文字。Footer 状态显示 `verify 已通过数/总数`。

直接写入/编辑、未登记且非已知只读检查的 Shell、未知工具及用户 `!` 命令会保守地使旧证据过期；与修改重叠的验收不会显示为新鲜通过。普通只读检查不会使记录过期。工具失败也可能留下部分修改，因此写入失败不会保留旧的通过状态。

清单与证据以 `pi-kit.verification` 自定义条目跟随会话分支保存，不额外复制工具输出。恢复、重载和树导航保留旧记录，但要求重新验收，因为会话历史不等于文件快照。`/verify reset` 显式清空当前清单，不删除历史记录；状态损坏或保存失败会报错，不静默当作通过。

Agent 结束时仅提醒缺失、失败或过期的验收，不阻止结束、不追加模型请求、不自动循环。没有登记清单时不写入验收状态、不添加提示章节。

这是一份**命令执行证据，不是任务正确性证明或代码快照**。修订计数不等于 Git commit 或内容哈希；外部编辑、后台进程和脚本内部的间接写入不能全面追踪。当前只采集 `bash` 工具的结构化退出码，不把 `!` 输出或任意插件的文字结果当作验收通过。登记命令也会保存在会话中，不要把凭据直接写入命令。

## Handoff

长会话进入新阶段时可生成一个聚焦的新会话提示：

```text
/handoff 继续实现下一阶段并运行相关测试
```

Handoff 使用 Pi 官方 `buildSessionProjection()` 获取当前分支的有效上下文，遵循压缩边界及 `context_edit` 的排除与替换，保留有效的分支摘要和自定义上下文消息，不修改原始会话记录。若没有可总结的文本，不发起模型调用。

Handoff 会使用当前模型总结相关上下文，允许编辑生成结果，然后创建带父会话关联的新 Session，并使用 `/handoff` 后的目标自动命名（最长 60 个字符）。它通过 Pi 的 `modelRegistry.complete()` 额外产生一次模型调用，由 Pi 统一处理认证（不强制要求 API Key），使用独立请求会话并关闭该次调用的缓存保留。生成错误、空正文或取消不会创建新会话；本地模式下如果 Dirty Repo Guard 检测到未提交改动，切换前仍会要求确认。

## Dirty Repo Guard

执行 `/new`、`/resume`、`/fork` 或 `/clone` 前检查本地 Git 状态：

- 本地模式检查 Pi 当前目录
- 无 UI 或无法验证本地状态时 fail-closed
- 未提交改动使用与 Safety Guard 一致的主题化确认框；选中 `No` 后可按 Tab 输入反馈
- SSH 模式直接跳过，不执行远程 Git 检查，也不会误检查本地工作区

检查会在 Session 操作前自动执行；非 Git 目录不会阻止会话操作。本地状态可直接使用 `git status` 查看。

## Tokyo Night Theme

Pi package 提供 `pi-kit-tokyo-night` 主题，统一原生 User/Assistant 消息、Handoff Loader、工具状态、Markdown、代码高亮、输入框和思考等级边框。通过 `/settings` 选择：

```text
Theme: pi-kit-tokyo-night
```

普通工作流使用蓝色边框与青色强调；成功、警告和错误继续使用绿、金、红。Safety Guard 确认框保留橙色边框与金色标题，以区别普通操作和风险确认。修改包内 `themes/pi-kit-tokyo-night.json` 后执行 `/reload` 应用。

## Compact Tools

Bash、Read、Edit、Write、Exa Search 统一采用无整块底色的紧凑展示。Bash 示例：

```text
✓ Bash · npm test · 1.2s
  test:ssh ok
  test:verification ok

✗ Bash · npm run build · 2.4s
  src/main.ts:18 — Type 'string' is not assignable to type 'number'
```

工具名使用主题蓝色，准备/运行、成功、失败分别使用黄、绿、红。折叠命令淡化，最多预览首行的 48 个终端列；耗时紧跟命令，不贴窗口右侧。普通输出使用正文色，比命令摘要更突出。展开详情后才显示完整 Shell 语法高亮及超时上限。状态依据宿主的执行状态，不解析输出文字推断成功或退出码；旧历史缺少耗时时不编造计时。

所有命令统一使用原始首行的截断预览，不为 Node 等命令生成特殊摘要，也不解析 Shell。短命令直接显示，过长或多行的完整内容可展开查看。

普通输出预览最后 3 个非空屏幕行；失败时最多显示 6 行，较长的错误保留开头与末尾，中间明确标记省略。空行只在折叠预览中跳过，展开后保留原文，避免错误正文被空行和末尾退出码挤掉。

Bash 命令与输出共用底部一条展开提示，计数表示当前结果中的逻辑行数。`Ctrl+O` 全局切换会话中的展开/折叠状态，Fullscreen 模式可点击单条工具结果局部展开，提示跟随自定义快捷键。工具自身已截断的内容不能靠展开恢复，完整日志路径和截断提示仍会显示。

Read 突出文件路径、请求的行范围与耗时，预览开头 3 个屏幕行，保留语法着色、图片显示及不支持图片时的原生文字回退。范围如 `L10–29` 表示请求范围，不代表文件实际返回了 20 行。长路径优先保留文件名，展开后显示完整路径和已返回内容。

Edit 显示路径、耗时和实际结果中的增删行数，预览最多 6 个屏幕行，展开可查看完整的已返回 diff。直接复用 Pi 的原生 diff 绘制，保留增删色与词级高亮；不会为渲染预读本机文件，也不把待执行的替换当成已完成的改动。读取和编辑失败时优先显示真实错误正文，工具截断警告始终可见，路径与内容共用一条展开提示。

Write 显示路径、耗时和宿主执行状态；已开始但未完成的调用显示“处理中”，涵盖等待审批。成功后预览提交的 `content` 参数及原始结果，折叠正文最多 3 个屏幕行，展开保留完整提交内容与原始结果。内容预览不是写后读回，也不生成 diff、猜测新增/覆盖或推算实际字节/行数；失败时只显示真实错误，不把拟写入内容当成成功结果。不会为展示读取文件或再次写入。

Bash 保留常规 ANSI 前景色和粗体，过滤背景色、隐藏文字、光标/清屏及 OSC 控制。文件内容在语法/diff 着色前清理终端控制，保留原生 diff 生成的词级反显。此处理只作用于展示，不修改实际命令、工具结果、会话日志、模型上下文或 `/verify` 证据，不影响 SSH 与安全守卫。其他工具及用户 `!` 命令暂不更改。

需要宿主提供独立的 `registerToolRenderer` 接口，已验证 Pi 1.4.0；0.99.2 没有此接口，保持原生显示，不通过重新注册工具来兼容。没有新依赖或 Pi 命令。修改后执行 `/reload` 预览；也可单独查看合成示例：

```bash
npm run test:tool-ui -- --preview
```

## Custom Footer

Footer 使用两行布局：

```text
LOCAL ~/pi-kit (main)                     gpt-5.6-sol • high
↑281k ↓58k R12M CH99.6% $9.059(sub)       ctx 44.5%/372k auto
```

统计缓存按会话、当前历史节点和模型复用，避免流式输出的每帧都扫描全部历史；导航和显式失效时重新计算。累计用量与 Pi 原生 Footer 保持相同口径，包含所有分支中已记录的 Assistant、工具调用、压缩、分支摘要及缓存预热用量；`CH` 仍表示最近一次 Assistant 请求的缓存命中率，不含 Exa 等外部服务的独立费用。

SSH 模式会将第一行目标切换为 `SSH alias:/remote/path`，避免混淆本地与远程操作。颜色可以通过以下文件覆盖：

```text
~/.pi/agent/footer-colors.json
```

配置字段可只写需要修改的部分，支持 `#RRGGBB` 和 0–255 色号：

```json
{
  "local": "#7aa2f7",
  "path": "#67e8f9",
  "ssh": "#ff9e64",
  "branch": "#4ade80",
  "session": "#f0a6ca",
  "model": "#c0caf5",
  "thinking": {
    "off": "#565f89",
    "minimal": "#7aa2f7",
    "low": "#7dcfff",
    "medium": "#73daca",
    "high": "#bb9af7",
    "xhigh": "#ff9e64",
    "max": "#f7768e"
  },
  "context": {
    "normal": "#4ade80",
    "warning": "#e0af68",
    "error": "#f7768e"
  }
}
```

修改后执行 Pi 内置的 `/reload`；使用 `/footer-colors` 查看配置路径。

## Titlebar Spinner

Agent 工作时，终端标签标题会显示 Braille 动画；完成、取消或退出后恢复为 Session 与本地/SSH 目标名称。使用以下命令临时开关：

```text
/title-spinner
```

## 可选：安装行为规范

Pi package 不会自动加载仓库根目录的 `AGENTS.md`。已有全局规则时请先手动合并；否则可复制到：

```text
~/.pi/agent/AGENTS.md
```

## 结构

```text
pi-kit/
├── .github/workflows/ci.yml
├── AGENTS.md
├── extensions/
│   ├── compact-tools/
│   ├── custom-footer/
│   ├── dirty-repo-guard/
│   ├── exa-search/
│   ├── handoff/
│   ├── presets/
│   ├── safety-guard/
│   ├── sensitive-paths/
│   ├── ssh-remote/
│   ├── titlebar-spinner/
│   └── verification/
├── themes/
│   └── pi-kit-tokyo-night.json
├── scripts/
└── package.json
```

## 验证

```bash
npm ci
npm run validate
npm test
git diff --check
```

GitHub Actions 使用 Node.js 24，在 Ubuntu 和 Windows 上于 main Push 与 Pull Request 中自动运行同一套检查。开发依赖保留 Pi 0.99.2 基线，另外在临时目录安装隔离的 Pi 1.4.0 主机运行 SDK 集成测试，不修改项目依赖或 lockfile。

`npm test` 包含真实 SDK 加载全部扩展、工具调用与守卫、SSH 路径、skill 读取、验收记录、归档与重载测试。Skill 边界测试使用临时样本，不再依赖或提供内置 Skill。SDK 测试的 SSH 进程由内存模拟传输替代，不连接服务器、不调用模型、不执行测试中的危险命令字符串。

`npm run test:ssh` 另含本地 Bash/GNU coreutils 的真实临时文件测试：截断/等长损坏输入、权限与符号链接、硬链接拒绝、属性复制/提交失败、取消和普通编辑。Linux 使用 `/tmp`；Windows 使用已安装的 WSL 且只写其 `/tmp`，不安装发行版；无 WSL 时仅跳过这组 Unix 文件系统用例，Windows 模拟传输/SDK 测试照常运行。真实网络中断仍需另行验证。

单独运行 SDK 集成测试：

```bash
npm run test:integration
```

可通过 `PI_KIT_TEST_AGENT_ENTRY` 指向另一个**已经安装的** Pi SDK 的 `dist/index.js`，验证实际使用的版本；测试脚本本身不会下载依赖。

长会话发生滚动跳转时，可先临时比较 Pi 原生 fullscreen 模式，无需修改全局配置或安装扩展：

```bash
pi --tui-mode fullscreen
```

Fullscreen 使用固定输入区和 Footer，以及独立滚动的历史区域；终端交互效果仍需在实际终端中验证。

## License

MIT
