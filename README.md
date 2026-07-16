# pi-kit

个人 [Pi](https://pi.dev) 配置包：安全、SSH 与工作流扩展，以及两个开发 Skills。

- **Safety Guard**：阻止灾难性删除和 WSL/Linux 对 Windows 挂载路径的写入；通过主题化选择框确认删除、依赖变更、Git 写操作及系统级命令
- **Sensitive Paths**：阻止直接修改 Git 元数据和私钥，并在写入环境变量、凭据及 secrets 文件前确认
- **SSH Remote**：按需将 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 和 `!` 命令路由到 SSH 服务器
- **Custom Footer**：突出显示本地/SSH 目标、Git 分支、模型、思考等级和上下文用量，并支持独立配色
- **Presets**：提供严格只读的 `review` 工作流，统一限制工具、Shell 命令和提示指令
- **Handoff**：将长会话压缩为可编辑的新会话启动提示
- **Dirty Repo Guard**：在切换、Fork 或 Clone 会话前检查本地 Git 工作区；SSH 模式直接跳过
- **Titlebar Spinner**：Agent 工作时在终端标题显示动画和当前目标
- **Skills**：`code-review`、`debugging`
- **AGENTS.md**：可选的个人开发规范

## 安装

本地目录：

```bash
pi install /absolute/path/to/pi-kit
```

GitHub 发布后：

```bash
pi install git:github.com/AstraNoctis03/pi-kit
```

临时测试：

```bash
pi --no-extensions --no-skills \
  -e ./extensions/safety-guard/index.ts \
  --skill ./skills/code-review/SKILL.md
```

## Safety Guard

直接阻止：

- `rm -rf /` 和递归删除 home
- 在 WSL/Linux 中通过工具或 Shell 写入 `/mnt/c`、`/mnt/d`、`C:\`、`D:\`

要求确认（`Yes` / `No`；选中 `No` 后可按 Tab 输入反馈）：

- 删除文件或目录
- 安装、卸载或更新依赖
- Git 写操作
- `sudo`、递归权限变更、系统服务、关机、重启、格式化及 `dd of=...`

普通文件编辑、测试、lint、build、Git 只读命令，以及原生 Windows 中的项目文件修改不会触发确认。

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

远程模式会禁用 SSH 配置中的 `LocalForward`，避免并行工具调用争用本地转发端口。连接失败后工具会保持 fail-closed，不会退回本地执行。使用 `/ssh-status` 查看当前目标。

要求：

- 已配置基于密钥或 Agent 的非交互 SSH 登录
- 远程系统提供 Bash、GNU `find`、`head` 和 GNU `grep`
- `grep` 优先使用远程 ripgrep（`rg`），未安装时自动回退到 GNU `grep`

GNU `grep` 回退与远程 `find` 会排除 `.git`、`node_modules`，但不会解析其他 `.gitignore` 规则。

SSH 扩展不会建立安全沙箱。首次使用应选择测试目录，并确保远程数据有备份和最小权限保护；条件允许时也可使用 Git。

## Presets

内置 `review` 工作流：

- 思考等级为 `high`
- 启用 `read`、`bash`、`grep`、`find`、`ls`
- Bash 只允许 Git 只读、文件检查、测试、lint 和类型检查命令
- 阻止 Shell 重定向、命令链、文件修改、依赖变更和 Git 写操作
- `write` / `edit` 即使被其他配置重新启用也会被拦截

Review 的 Bash 限制是静态白名单而非操作系统沙箱；已阻止已知输出文件、外部 helper、重定向和修复参数，但获准的项目测试脚本仍可能按项目自身逻辑生成缓存或构建产物。最终只读保证仍应结合只读工作区或容器。

使用方式：

```text
/preset review
/preset normal
```

`normal` 恢复启用 Review 前的模型、思考等级和完整工具；简单任务通过 `Shift+Tab` 调整思考强度，无需额外 Preset。

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

## Handoff

长会话进入新阶段时可生成一个聚焦的新会话提示：

```text
/handoff 继续实现下一阶段并运行相关测试
```

Handoff 会使用当前模型总结相关上下文，允许编辑生成结果，然后创建带父会话关联的新 Session。它会额外产生一次模型调用；本地模式下如果 Dirty Repo Guard 检测到未提交改动，切换前仍会要求确认。

## Dirty Repo Guard

执行 `/new`、`/resume`、`/fork` 或 `/clone` 前检查本地 Git 状态：

- 本地模式检查 Pi 当前目录
- 无 UI 或无法验证本地状态时 fail-closed
- 未提交改动使用与 Safety Guard 一致的主题化确认框；选中 `No` 后可按 Tab 输入反馈
- SSH 模式直接跳过，不执行远程 Git 检查，也不会误检查本地工作区

检查会在 Session 操作前自动执行；非 Git 目录不会阻止会话操作。本地状态可直接使用 `git status` 查看。

## Custom Footer

Footer 使用两行布局：

```text
LOCAL ~/pi-kit (main)                     gpt-5.6-sol • high
↑281k ↓58k R12M CH99.6% $9.059(sub)       ctx 44.5%/372k auto
```

SSH 模式会将第一行目标切换为 `SSH alias:/remote/path`，避免混淆本地与远程操作。颜色可以通过以下文件覆盖：

```text
~/.pi/agent/footer-colors.json
```

配置字段可只写需要修改的部分，支持 `#RRGGBB` 和 0–255 色号：

```json
{
  "path": "#67e8f9",
  "ssh": "#f59e0b",
  "branch": "#4ade80",
  "model": "#c4b5fd",
  "thinking": {
    "off": "#6b7280",
    "minimal": "#93c5fd",
    "low": "#38bdf8",
    "medium": "#34d399",
    "high": "#fbbf24",
    "xhigh": "#fb923c",
    "max": "#f87171"
  },
  "context": {
    "normal": "#4ade80",
    "warning": "#fbbf24",
    "error": "#f87171"
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
├── AGENTS.md
├── extensions/
│   ├── custom-footer/
│   ├── dirty-repo-guard/
│   ├── handoff/
│   ├── presets/
│   ├── safety-guard/
│   ├── sensitive-paths/
│   ├── ssh-remote/
│   └── titlebar-spinner/
├── skills/
│   ├── code-review/SKILL.md
│   └── debugging/SKILL.md
├── scripts/
└── package.json
```

## 验证

```bash
npm install
npm run validate
npm run test:safety
npm run test:ssh
npm run test:footer
npm run test:workflow
npm run test:session-extensions
```

## License

MIT
