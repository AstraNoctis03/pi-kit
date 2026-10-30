import path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ENVIRONMENT_ENTRY,
	environmentDescription,
	readEnvironment,
	readEnvironmentFile,
	sameDirectory,
	sameEnvironment,
	type SessionEnvironment,
} from "./environment.ts";
import { showEnvironmentPicker } from "./resume-picker.ts";
import { SessionIndex } from "./session-index.ts";
import { ResumeStateStore } from "./resume-state.ts";
import { sessionTargetLabel } from "./session-label.ts";

export function createEnvironmentSessions(pi: ExtensionAPI, onClaim: (ctx: ExtensionContext) => void,
	store = new ResumeStateStore(path.join(getAgentDir(), "resume-env-state.jsonl"))) {
	let current: SessionEnvironment | undefined;
	const index = new SessionIndex();
	// Ownership is immutable across turns and tree navigation. Avoid rescanning long histories per tool.
	const owners = new WeakMap<ExtensionContext["sessionManager"], SessionEnvironment | undefined>();
	const saved = (ctx: ExtensionContext) => {
		if (!owners.has(ctx.sessionManager)) owners.set(ctx.sessionManager, readEnvironment(ctx.sessionManager.getEntries()));
		return owners.get(ctx.sessionManager);
	};
	const allowed = (ctx: ExtensionContext) => {
		const owner = saved(ctx);
		return !!current && !!owner && sameDirectory(owner, current);
	};
	const blockedReason = (ctx: ExtensionContext) =>
		`Session environment: ${environmentDescription(saved(ctx))}; current: ${environmentDescription(current)}. `
		+ (saved(ctx) ? "Restart Pi in the matching environment; this session was not relabeled."
			: "Inspect this legacy session, then use /claim to explicitly assign it to the current environment.");

	const claim = async (ctx: ExtensionCommandContext) => {
		if (!current || saved(ctx)) {
			ctx.ui.notify("Only unknown sessions in an initialized environment can be claimed. Existing ownership is immutable.", "warning");
			return;
		}
		if (ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === ENVIRONMENT_ENTRY)) {
			ctx.ui.notify("Invalid environment metadata; refusing to overwrite it.", "error");
			return;
		}
		if (!ctx.hasUI || !await ctx.ui.confirm("认领当前会话？",
			`请确认历史属于当前环境：${environmentDescription(current)}`)) return;
		pi.appendEntry(ENVIRONMENT_ENTRY, current);
		owners.set(ctx.sessionManager, current);
		onClaim(ctx);
		ctx.ui.notify("Session environment recorded.", "info");
	};
	pi.registerCommand("claim", {
		description: "Assign this unknown legacy session to the current environment (with confirmation)",
		handler: async (_args, ctx) => claim(ctx),
	});
	pi.registerCommand("session-env", {
		description: "Show session ownership; /claim assigns an unknown legacy session",
		handler: async (args, ctx) => {
			if (args.trim() === "claim") return claim(ctx); // Backward-compatible alias.
			ctx.ui.notify(`Session: ${environmentDescription(saved(ctx))}\nCurrent: ${environmentDescription(current)}`, "info");
		},
	});

	pi.registerCommand("resume-env", {
		description: "Resume sessions in the current environment; /resume-env archived shows archived sessions",
		handler: async (args, ctx) => {
			if (args.trim() && args.trim() !== "archived") {
				ctx.ui.notify("Usage: /resume-env [archived]", "warning");
				return;
			}
			if (ctx.mode !== "tui" || !current) {
				ctx.ui.notify("/resume-env requires an initialized environment and interactive TUI mode.", "error");
				return;
			}
			await ctx.waitForIdle();
			const cwd = path.resolve(ctx.sessionManager.getCwd());
			const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const defaultDir = path.join(getAgentDir(), "sessions", encoded);
			const sessionDir = ctx.sessionManager.getSessionDir();
			const grouped = path.resolve(sessionDir) === defaultDir;
			const root = grouped ? path.dirname(defaultDir) : sessionDir;
			const selected = await showEnvironmentPicker(ctx, current,
				(publish, signal) => index.list(root, grouped, publish, signal),
				{ store, archiveView: args.trim() === "archived" ? "archived" : "active" });
			if (selected && selected !== ctx.sessionManager.getSessionFile()) await ctx.switchSession(selected);
		},
	});

	// Applies to the native /resume too. Cross-environment switching is never implicit.
	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "resume" || !event.targetSessionFile) return;
		try {
			const owner = await readEnvironmentFile(event.targetSessionFile);
			if (!current || (owner && !sameEnvironment(owner, current))) {
				ctx.ui.notify(`Cannot resume ${environmentDescription(owner)} in ${environmentDescription(current)}. Switch environment first.`, "warning");
				return { cancel: true };
			}
		} catch (error) {
			ctx.ui.notify(`Cannot verify target session: ${String(error)}`, "error");
			return { cancel: true };
		}
	});
	pi.on("tool_call", async (_event, ctx) => allowed(ctx) ? undefined : { block: true, reason: blockedReason(ctx) });
	pi.on("user_bash", async (_event, ctx) => allowed(ctx) ? undefined : {
		result: { output: blockedReason(ctx), exitCode: 1, cancelled: false, truncated: false },
	});

	return {
		activate(ctx: ExtensionContext, environment: SessionEnvironment) {
			current = environment;
			const entries = ctx.sessionManager.getEntries();
			owners.set(ctx.sessionManager, readEnvironment(entries));
			const hasHistory = entries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary"
				|| entry.type === "custom_message" || (entry.type === "message" && entry.message.role !== "system"));
			if (!hasHistory && !entries.some((entry) => entry.type === "custom" && entry.customType === ENVIRONMENT_ENTRY)) {
				pi.appendEntry(ENVIRONMENT_ENTRY, environment);
				owners.set(ctx.sessionManager, environment);
			}
			if (!allowed(ctx)) ctx.ui.notify(blockedReason(ctx), "warning");
		},
		allowed,
		blockedReason,
		label(ctx: ExtensionContext): string | undefined {
			const owner = saved(ctx);
			if (!owner) return undefined;
			return sessionTargetLabel(owner.kind === "ssh" ? owner.host : undefined, owner.cwd);
		},
	};
}
