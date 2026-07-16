import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showThemedConfirmation } from "../safety-guard/dialog.ts";
import {
	classifySensitivePath,
	loadSensitivePathRules,
	sensitivePathCandidates,
	type SensitivePathRules,
} from "./config.ts";

export default function sensitivePaths(pi: ExtensionAPI): void {
	let rules: SensitivePathRules;
	let globalPath = "";
	let projectPath = "";

	function loadRules(cwd: string, projectTrusted: boolean, notify: (message: string) => void): void {
		const loaded = loadSensitivePathRules(cwd, projectTrusted);
		rules = loaded.rules;
		globalPath = loaded.globalPath;
		projectPath = loaded.projectPath;
		for (const error of loaded.errors) notify(`Sensitive paths config error: ${error}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		loadRules(ctx.cwd, ctx.isProjectTrusted(), (message) => ctx.ui.notify(message, "warning"));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;
		const sshFlag = pi.getFlag("ssh");
		const candidates = typeof sshFlag === "string" && sshFlag
			? [event.input.path]
			: sensitivePathCandidates(event.input.path, ctx.cwd);
		const decision = candidates
			.map((candidate) => classifySensitivePath(candidate, rules))
			.find((candidate) => candidate !== undefined);
		if (!decision) return undefined;

		if (decision.action === "block") {
			const reason = `Sensitive Paths blocked writing ${event.input.path} (matched ${decision.pattern}).`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Sensitive Paths requires confirmation for ${event.input.path} (matched ${decision.pattern}).`,
			};
		}
		const result = await showThemedConfirmation(
			ctx,
			"Sensitive path confirmation",
			`This operation writes a potentially sensitive file (matched ${decision.pattern}).`,
			`Path: ${event.input.path}`,
		);
		if (result.allowed) return undefined;
		const feedback = result.feedback ? ` User feedback: ${result.feedback}` : "";
		return { block: true, reason: `Sensitive Paths: user rejected writing ${event.input.path}.${feedback}` };
	});

	pi.registerCommand("sensitive-paths", {
		description: "Show sensitive path guard configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					`Sensitive path rules: ${rules.block.length} block, ${rules.confirm.length} confirm, ${rules.allow.length} allow`,
					`Global: ${globalPath}`,
					`Project: ${projectPath}`,
				].join("\n"),
				"info",
			);
		},
	});
}
