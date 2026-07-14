# pi-kit

个人 [Pi](https://pi.dev) 配置包：一个安全扩展和两个开发 Skills。

- **Safety Guard**：阻止灾难性删除和 WSL/Linux 对 Windows 挂载路径的写入；通过主题化选择框确认删除、依赖变更、Git 写操作及系统级命令
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

## 可选：安装行为规范

Pi package 不会自动加载仓库根目录的 `AGENTS.md`。已有全局规则时请先手动合并；否则可复制到：

```text
~/.pi/agent/AGENTS.md
```

## 结构

```text
pi-kit/
├── AGENTS.md
├── extensions/safety-guard/
│   ├── dialog.ts
│   ├── index.ts
│   └── policy.ts
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
```

## License

MIT
