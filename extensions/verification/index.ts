import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewCommandDecision } from "../presets/review-policy.ts";
import { environmentDescription, readEnvironment } from "../ssh-remote/environment.ts";

const ENTRY = "pi-kit.verification";
const MAX_CHECKS = 12;
const MAX_COMMAND = 1000;
const READ_TOOLS = new Set(["read", "ls", "grep", "find", "exa_search"]);
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
interface Run {
	command: string;
	toolCallId: string;
	target: string;
	startedAt: number;
	finishedAt: number;
	revision: number;
	overlapped: boolean;
	exitCode: number | null;
	isError: boolean;
}
interface State { version: 1; commands: string[]; revision: number; runs: Run[] }
interface Pending { command?: string; startedAt: number; revision: number; overlapped: boolean; mutation: boolean; target: string }
const empty = (): State => ({ version: 1, commands: [], revision: 0, runs: [] });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function validState(value: unknown): value is State {
	if (!object(value) || value.version !== 1 || !integer(value.revision) || !Array.isArray(value.commands)
		|| value.commands.length > MAX_CHECKS || !Array.isArray(value.runs) || value.runs.length > value.commands.length) return false;
	const commands: unknown[] = value.commands;
	const revision = value.revision;
	if (commands.some((command) => typeof command !== "string" || !command.trim() || command !== command.trim() || command.length > MAX_COMMAND)
		|| new Set(commands).size !== commands.length) return false;
	return value.runs.every((run: unknown) => object(run) && commands.includes(run.command)
		&& typeof run.toolCallId === "string" && !!run.toolCallId.trim() && typeof run.target === "string" && !!run.target.trim()
		&& integer(run.revision) && run.revision <= revision
		&& integer(run.startedAt) && integer(run.finishedAt) && run.finishedAt >= run.startedAt && run.finishedAt <= 8_640_000_000_000_000
		&& typeof run.overlapped === "boolean" && typeof run.isError === "boolean"
		&& (run.exitCode === null || integer(run.exitCode)))
		&& new Set(value.runs.map((run: Run) => run.command)).size === value.runs.length;
}

function inspection(command: string): boolean {
	// Reuse the existing shell-policy checks, but exclude project scripts/checks:
	// permitting a test in Review does not establish that the script cannot write.
	return /^(?:git|pwd|ls|cat|head|tail|wc|stat|file)(?:\s|$)/.test(command)
		&& reviewCommandDecision(command).allowed;
}
function exitCode(result: unknown): number | null {
	if (!object(result) || !object(result.structuredContent)) return null;
	const code = result.structuredContent.exit_code;
	return integer(code) ? code : null; // Never infer success from human-readable output.
}
function target(ctx: ExtensionContext): string {
	const owner = readEnvironment(ctx.sessionManager.getEntries());
	return owner ? environmentDescription(owner) : `LOCAL ${hostname()}:${ctx.cwd}`;
}

export default function verification(pi: ExtensionAPI): void {
	let state = empty();
	let problem: string | undefined;
	const pending = new Map<string, Pending>();
	const mutations = new Set<string>();
	const status = (command: string): string => {
		if ([...pending.values()].some((call) => call.command === command && !call.mutation)) return "运行中";
		const run = state.runs.find((item) => item.command === command);
		if (!run) return "未运行";
		if (run.overlapped || run.revision !== state.revision) return "已过期";
		if (run.isError || (run.exitCode !== null && run.exitCode !== 0)) return "失败";
		return run.exitCode === 0 ? "通过(退出码0)" : "结果未知";
	};
	const update = (ctx: ExtensionContext) => {
		const passed = state.commands.filter((command) => status(command) === "通过(退出码0)").length;
		ctx.ui.setStatus("verification", problem ? "verify: 状态错误" : state.commands.length ? `verify ${passed}/${state.commands.length}` : undefined);
	};
	const save = (next: State, ctx: ExtensionContext) => {
		state = next;
		try { pi.appendEntry(ENTRY, state); }
		catch (error) {
			problem = `验收记录保存失败：${String(error)}`;
			update(ctx);
			throw error;
		}
		update(ctx);
	};
	const invalidate = (ctx: ExtensionContext) => {
		const fresh = state.runs.some((run) => !run.overlapped && run.revision === state.revision);
		const next = { ...state, revision: state.revision + 1 };
		// Persist the first invalidation; avoid repeating the full checklist for
		// every subsequent edit while all previous evidence is already stale.
		if (fresh) save(next, ctx);
		else { state = next; update(ctx); }
	};
	const restore = (ctx: ExtensionContext) => {
		pending.clear(); mutations.clear(); problem = undefined; state = empty();
		const entry = ctx.sessionManager.getBranch().filter((item) => item.type === "custom" && item.customType === ENTRY).at(-1);
		if (entry?.type === "custom") {
			if (validState(entry.data)) state = entry.data;
			else problem = "验收记录损坏或版本不支持；使用 /verify reset 显式重置。";
		}
		// History navigation/reload does not restore files. Preserve old evidence,
		// but never present it as a fresh verification of the current workspace.
		if (state.runs.length) invalidate(ctx);
		else update(ctx);
		if (problem) ctx.ui.notify(problem, "error");
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		pending.clear(); mutations.clear(); ctx.ui.setStatus("verification", undefined);
	});

	pi.registerCommand("verify", {
		description: "Show verification evidence; /verify add <command> registers without executing; /verify reset clears the checklist",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				const lines = state.commands.map((command) => {
					const run = state.runs.find((item) => item.command === command);
					return `[${status(command)}] ${clean(command)}${run ? `\n  ${clean(run.target)} · ${new Date(run.finishedAt).toISOString()} · exit ${run.exitCode ?? "unknown"} · ${clean(run.toolCallId)}` : ""}`;
				});
				ctx.ui.notify(problem ?? (lines.length ? lines.join("\n") : "未配置验收命令。/verify add <command> 只登记，不执行。"), problem ? "error" : "info");
				return;
			}
			if (!ctx.isIdle()) { ctx.ui.notify("请等当前任务结束后修改验收清单。", "warning"); return; }
			if (input === "reset") {
				problem = undefined; pending.clear(); mutations.clear(); save(empty(), ctx);
				ctx.ui.notify("验收清单已重置；历史记录未删除。", "info"); return;
			}
			if (problem) { ctx.ui.notify(problem, "error"); return; }
			const command = input.startsWith("add ") ? input.slice(4).trim() : "";
			if (!command || command.length > MAX_COMMAND) { ctx.ui.notify("用法：/verify [add <command> | reset]；命令最多 1000 字符。", "warning"); return; }
			if (state.commands.includes(command)) { ctx.ui.notify("该验收命令已登记。", "info"); return; }
			if (state.commands.length >= MAX_CHECKS) { ctx.ui.notify("最多登记 12 条验收命令。", "warning"); return; }
			save({ ...state, commands: [...state.commands, command] }, ctx);
			ctx.ui.notify("已登记，不会自动执行；登记不代表授权运行。", "info");
		},
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (problem || !state.commands.length) return;
		const args: unknown = event.args;
		const command = event.toolName === "bash" && object(args) && typeof args.command === "string" ? args.command.trim() : undefined;
		const check = command !== undefined && state.commands.includes(command);
		// Codemode itself cannot access the host; observe its nested tool events.
		const mutation = !READ_TOOLS.has(event.toolName) && event.toolName !== "codemode"
			&& !(command !== undefined && (check || inspection(command)));
		pending.set(event.toolCallId, { command, mutation, revision: state.revision, overlapped: mutations.size > 0,
			startedAt: Date.now(), target: check ? target(ctx) : "" });
		if (mutation) { mutations.add(event.toolCallId); invalidate(ctx); }
		else update(ctx);
	});
	pi.on("tool_result", (event, ctx) => {
		const call = pending.get(event.toolCallId);
		if (call?.command !== undefined && typeof event.input.command === "string" && call.command !== event.input.command.trim()) {
			// Another extension changed the command after the start event. Do not
			// credit the original request, or guess which code revision it checked.
			call.command = undefined; call.mutation = true;
			mutations.add(event.toolCallId); invalidate(ctx);
		}
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const call = pending.get(event.toolCallId);
		if (!call) return;
		pending.delete(event.toolCallId);
		if (call.mutation) { mutations.delete(event.toolCallId); invalidate(ctx); }
		else if (call.command !== undefined && state.commands.includes(call.command)) {
			const run: Run = { command: call.command, toolCallId: event.toolCallId, target: call.target, startedAt: call.startedAt,
				finishedAt: Math.max(Date.now(), call.startedAt), revision: call.revision, overlapped: call.overlapped,
				exitCode: exitCode(event.result), isError: event.isError || (object(event.result) && event.result.isError === true) };
			save({ ...state, runs: [...state.runs.filter((item) => item.command !== run.command), run] }, ctx);
		} else update(ctx);
	});
	// Registered before SSH's handler, which returns operations and stops dispatch.
	pi.on("user_bash", (_event, ctx) => { if (!problem && state.commands.length) invalidate(ctx); });
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "bashExecution" && !problem && state.commands.length) invalidate(ctx);
	});
	pi.on("before_agent_start", (event) => {
		if (problem) {
			event.systemPromptOptions.sections.pi_kit_verification = "Verification evidence is unavailable. Do not claim verification is complete; ask the user to inspect /verify before resetting it.";
			return;
		}
		if (!state.commands.length) { delete event.systemPromptOptions.sections.pi_kit_verification; return; }
		event.systemPromptOptions.sections.pi_kit_verification = "Verification checklist at run start (registration is not execution authorization):\n"
			+ state.commands.map((command) => JSON.stringify({ command, status: status(command) })).join("\n")
			+ "\nRun checks through the normal bash tool and existing guards. Only exact command matches with a structured zero exit code count. "
			+ "Distinguish implementation from verification, report failures/stale/missing evidence, and do not claim that this log proves full task correctness. "
			+ "Do not automatically loop or repeat blocked commands. External edits and background processes are not fully tracked.";
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (problem || state.commands.some((command) => status(command) !== "通过(退出码0)")) {
			ctx.ui.notify(problem ?? "验收尚未全部通过或记录已过期；/verify 查看证据。", "warning");
		}
	});
}
