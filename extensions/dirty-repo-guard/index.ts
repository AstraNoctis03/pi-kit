import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showThemedConfirmation } from "../safety-guard/dialog.ts";

interface RepoStatus {
	isRepository: boolean;
	status: string;
	target: string;
}

function hasGitMarker(cwd: string): boolean {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

async function getRepoStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RepoStatus | undefined> {
	const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 15_000 });
	if (result.code !== 0) {
		if (result.killed) throw new Error(`Cannot inspect LOCAL ${ctx.cwd}: git status timed out or was cancelled`);
		if (!hasGitMarker(ctx.cwd)) return { isRepository: false, status: "", target: `LOCAL ${ctx.cwd}` };
		const detail = result.stderr.trim() || `git status exited with code ${result.code}`;
		throw new Error(`Cannot inspect LOCAL ${ctx.cwd}: ${detail}`);
	}
	return { isRepository: true, status: result.stdout, target: `LOCAL ${ctx.cwd}` };
}

async function guardSessionChange(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
): Promise<{ cancel: true } | undefined> {
	const sshFlag = pi.getFlag("ssh");
	if (typeof sshFlag === "string" && sshFlag) return undefined;

	let repo: RepoStatus | undefined;
	try {
		repo = await getRepoStatus(pi, ctx);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Cannot verify repository state: ${reason}`, "error");
		return { cancel: true };
	}
	if (!repo?.isRepository) return undefined;
	const changes = repo.status.split(/\r?\n/).filter(Boolean);
	if (changes.length === 0) return undefined;
	if (!ctx.hasUI) return { cancel: true };
	const result = await showThemedConfirmation(
		ctx,
		"Uncommitted changes",
		`${repo.target} has ${changes.length} uncommitted file(s).`,
		`Action: ${action}`,
	);
	if (result.allowed) return undefined;
	const feedback = result.feedback ? ` User feedback: ${result.feedback}` : "";
	ctx.ui.notify(`Session change cancelled; commit or stash your work first.${feedback}`, "warning");
	return { cancel: true };
}

export default function dirtyRepoGuard(pi: ExtensionAPI): void {
	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "starting a new session" : "switching sessions";
		return guardSessionChange(pi, ctx, action);
	});
	pi.on("session_before_fork", async (event, ctx) => {
		const action = event.position === "at" ? "cloning this session" : "forking this session";
		return guardSessionChange(pi, ctx, action);
	});
}
