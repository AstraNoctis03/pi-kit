import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSshTarget } from "../ssh-remote/config.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function sanitizeTitle(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

export function titleTarget(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const sshFlag = pi.getFlag("ssh");
	if (typeof sshFlag === "string" && sshFlag) {
		try {
			const target = parseSshTarget(sshFlag);
			const directory = target.remoteCwd ? path.posix.basename(target.remoteCwd) || "/" : undefined;
			return directory ? `${target.host}:${directory}` : target.host;
		} catch {
			return "SSH";
		}
	}
	return path.basename(ctx.cwd) || ctx.cwd;
}

function baseTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const sessionName = pi.getSessionName();
	const target = titleTarget(pi, ctx);
	return sanitizeTitle(sessionName ? `π • ${sessionName} • ${target}` : `π • ${target}`);
}

export default function titlebarSpinner(pi: ExtensionAPI): void {
	let enabled = true;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;

	function stop(ctx: ExtensionContext): void {
		if (timer) clearInterval(timer);
		timer = undefined;
		frame = 0;
		if (ctx.mode === "tui") ctx.ui.setTitle(baseTitle(pi, ctx));
	}

	function start(ctx: ExtensionContext): void {
		stop(ctx);
		if (!enabled || ctx.mode !== "tui") return;
		timer = setInterval(() => {
			ctx.ui.setTitle(`${FRAMES[frame % FRAMES.length]} ${baseTitle(pi, ctx)}`);
			frame += 1;
		}, 120);
	}

	pi.on("session_start", async (_event, ctx) => stop(ctx));
	pi.on("session_info_changed", async (_event, ctx) => {
		if (!timer) stop(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => start(ctx));
	pi.on("agent_settled", async (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", async (_event, ctx) => stop(ctx));

	pi.registerCommand("title-spinner", {
		description: "Toggle the terminal title spinner",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled && !ctx.isIdle()) start(ctx);
			else stop(ctx);
			ctx.ui.notify(`Title spinner ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
