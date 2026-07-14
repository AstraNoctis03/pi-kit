# 变更日志

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
