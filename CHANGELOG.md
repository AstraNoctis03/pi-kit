# 变更日志

## Unreleased

- 新增按 `--ssh alias:/remote/path` 启用的 SSH Remote 扩展。
- 远程路由文件读写、编辑、Shell、搜索、目录列表和用户 `!` 命令。
- SSH 连接使用 BatchMode、连接超时和 `ClearAllForwardings`，失败时不回退到本地工具。
- 新增 SSH 参数、路径映射和 Shell 转义测试。
- 新增两行 Custom Footer，突出本地/SSH 目标、Git 分支、模型、思考等级和上下文用量。
- Footer 独立颜色支持 `#RRGGBB` 与 256 色配置；修改后使用 Pi 内置 `/reload` 重载。
- 新增严格只读的 `review` Preset，支持 Git 只读、检查与测试命令，并在工具层阻止修改；支持全局/可信项目配置、CLI 参数和会话状态恢复。
- 新增 Sensitive Paths，保护 Git 元数据、私钥、环境变量和凭据文件，并支持可扩展的 allow/block/confirm 规则。
- 新增 Handoff，将长会话整理为可编辑的新会话启动提示。
- 新增本地 Dirty Repo Guard，在会话切换、Fork 和 Clone 前检查未提交改动；SSH 模式直接跳过。
- 新增 Titlebar Spinner，在 Agent 工作期间显示终端标题动画和当前目标。

## v0.1.0 - 2026-07-14

- 从 `omp-kit` 独立移植为原生 Pi package。
- 扩展精简为单一 `safety-guard`，策略与 Pi 事件入口分离。
- 删除 Auto-Confirm、状态组件、状态持久化和旧版手写 TUI。
- 使用 Pi 官方 `DynamicBorder`、`SelectList`、`Input` 和主题系统提供确认界面；选中 `No` 后可按 Tab 输入反馈。
- 普通编辑和验证命令默认允许；删除、依赖变更、Git 写操作和系统命令要求确认。
- Windows 路径保护改为环境感知：仅在 WSL/Linux 阻止 Windows 挂载路径写入。
- Skills 精简为规范命名的 `code-review` 和 `debugging`。
- 将必要的测试纪律合并到 `AGENTS.md`，并精简重复的行为规范。
- 扩充 Git 与系统服务只读命令识别，减少不必要确认。
- 精简资源验证脚本，并将 `package-lock.json` 纳入版本控制。
