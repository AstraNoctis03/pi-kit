# 变更日志

## Unreleased

- SSH `write` / `edit` 改为私有暂存、字节数与 SHA-256 校验后原子替换，避免不完整传输截断原文件；保留权限/所有权/ACL/xattr、符号链接和正常修改时间，拒绝会破坏语义的硬链接/特殊文件，并传递各调用的取消信号。补测本地 Linux/WSL 实文件故障与两版 SDK 模拟传输；明确回执丢失、并发竞态和掉电持久性的边界。

- 修复 Windows 下远端 `/a/...` 等 POSIX 路径误命中本地 skill、以及远端路径与本机 home/盘符映射冲突的问题；统一使用独立的虚拟路径命名空间，补测特殊字符与真实 SDK 工具边界。
- 新增可选登记的 `/verify` 验收清单：按真实工具事件保存命令、会话环境、时间和结构化退出码，修改、并发重叠和重载后使旧证据过期；仅提醒，不自动执行、授予权限、调用模型或续跑。补测状态恢复、错误、并发及两版 SDK 的守卫/SSH 组合。
- 修复 SSH 文件工具与 `!` 命令误用本机 cwd 的问题，在工具边界统一远端相对路径、父目录和 home 语义，并避免远端路径编码误触发本地 skill 读取例外。
- Safety Guard 扫描完整命令链后再请求确认，确保后续强制阻止规则优先；Review 修复双引号内反引号命令替换及反斜杠转义判断。
- 固化真实 Pi SDK 集成测试，覆盖全部扩展加载、守卫、SSH 路径/skill、归档和重载；CI 在 Windows/Ubuntu 增加隔离的 Pi 1.4.0 主机验证，保留 0.99.2 基线。
- 修复 SSH 模式把本机 `SKILL.md` 映射为远程路径导致加载失败的问题：只对 Pi 当前已加载的 skill 入口文件提供本地只读例外，保留远程工具路由、原生读取截断与失败关闭策略。
- 环境会话列表默认最近平铺，Ctrl+S 仅切换最近/层级并记住偏好；搜索自动按相关性排序。新增 Alt+A 单会话归档/取消归档、Alt+H 归档视图与 `/resume-env archived`；状态独立持久化，不修改对话文件或连带归档子会话。
- 增加 `/claim` 简写；环境会话列表复用 Pi 原生父子层级、搜索与排序，改为立即显示并逐步加载，使用单次流式扫描、内存缓存与追加增量索引，避免每次重复解析完整会话。
- 新增 `/resume-env`，默认按当前本地/SSH 环境筛选会话，Tab 切换环境、环境＋目录和所有环境；独立保存归属，未知旧会话需通过 `/session-env claim` 明确认领。
- 恢复会话时检查环境，禁止静默改写服务器标签；启动时环境不匹配或归属未知会阻止工具执行，同机跨目录恢复使用保存的远程目录。
- Handoff 改用官方上下文投影，移除手写历史整理逻辑；补测 context_edit 排除/替换、分支隔离、压缩保留范围、分支摘要和空上下文。
- Preset 与 SSH 改用独立结构化提示章节；SSH 直接设置提示中的远程 cwd，避免全文替换。补测重复回合、退出 Review、SSH 失败和两种扩展加载顺序的组合行为。
- 开发依赖固定到 Pi 0.99.2 / TypeBox 1.3.27，CI 增加 Windows 与 Ubuntu 双平台验证。
- Safety Guard 阻止尚未支持的独立 PowerShell 工具；Review 与 SSH 各自保留独立拦截，避免重新启用或嵌套调用时绕过策略、误执行本地命令。
- Custom Footer 缓存会话统计与上下文用量，减少长会话流式重绘开销；补计缓存预热、压缩、分支摘要及工具结果的 usage，保持最近 Assistant 的缓存命中率口径。
- Handoff 改用 Pi 官方模型调用入口统一处理认证，使用独立请求会话；补充生成失败、空正文、取消和延迟完成的保护与测试。
- Session 名称自动保留 `[LOCAL]` 或 `[SSH hostname:directory]` 目标前缀；SSH 使用远端实际短主机名统一公网/内网连接别名，便于在 `/resume` 中稳定区分和搜索执行目标。
- CI 仅在 main Push 与 Pull Request 运行，避免发布 Tag 重复执行同一套检查。

## v0.2.0 - 2026-07-17

- 新增按 `--ssh alias:/remote/path` 启用的 SSH Remote 扩展。
- 远程路由文件读写、编辑、Shell、搜索、目录列表和用户 `!` 命令。
- SSH 连接使用 BatchMode、连接超时和 `ClearAllForwardings`，失败时不回退到本地工具。
- 新增 SSH 参数、路径映射和 Shell 转义测试。
- 新增两行 Custom Footer，突出本地/SSH 目标、Git 分支、模型、思考等级和上下文用量。
- 新增 `pi-kit-tokyo-night` 主题，统一原生对话、Handoff、工具区域、Markdown、输入框和扩展界面的视觉语言。
- Footer 独立颜色支持 `#RRGGBB` 与 256 色配置，默认模型与推理等级采用协调的 Tokyo Night 配色；修改后使用 Pi 内置 `/reload` 重载。
- 新增严格只读的 `review` Preset，支持 Git 只读、检查与测试命令，并在工具层阻止修改；支持全局/可信项目配置、CLI 参数和会话状态恢复。
- 新增 Sensitive Paths，保护 Git 元数据、私钥、环境变量和凭据文件，并支持可扩展的 allow/block/confirm 规则。
- 新增 Handoff，将长会话整理为可编辑的新会话启动提示，并根据下一阶段目标自动命名新 Session。
- 新增本地 Dirty Repo Guard，在会话切换、Fork 和 Clone 前检查未提交改动；SSH 模式直接跳过。
- 新增本地只读 `exa_search` 工具，通过 Exa API 返回带来源和费用的网页搜索结果，并支持 Review 与 SSH 模式。
- 共享主题化确认框默认选中 `Yes`，支持可配置的自定义边框、标题与选中项颜色，并保留主题化正文。
- 新增 Titlebar Spinner，在 Agent 工作期间显示终端标题动画和当前目标。
- 新增基于 Node.js 24 的 GitHub Actions CI，在 Push 与 Pull Request 中运行资源、类型、完整测试和 Patch 空白检查。
- 补充 Exa 取消、超时和大输出截断，Handoff 创建与取消，以及官方 Theme Loader 的边界测试。

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
