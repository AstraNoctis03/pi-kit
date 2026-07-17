import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_FOOTER_COLORS,
	mergeFooterColors,
	paint,
	type FooterColors,
	type ThinkingLevel,
} from "./colors.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

function agentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR
		? path.resolve(process.env.PI_CODING_AGENT_DIR)
		: path.join(homedir(), ".pi", "agent");
}

export function footerColorsPath(): string {
	return path.join(agentDirectory(), "footer-colors.json");
}

function loadColors(configPath: string): { colors: FooterColors; error?: string } {
	if (!existsSync(configPath)) return { colors: structuredClone(DEFAULT_FOOTER_COLORS) };
	try {
		return { colors: mergeFooterColors(JSON.parse(readFileSync(configPath, "utf8"))) };
	} catch (error) {
		return {
			colors: structuredClone(DEFAULT_FOOTER_COLORS),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function readJson(pathname: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(pathname, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function compactionEnabled(ctx: ExtensionContext): boolean {
	const globalSettings = readJson(path.join(agentDirectory(), "settings.json"));
	const globalCompaction = globalSettings?.compaction as Record<string, unknown> | undefined;
	let enabled = globalCompaction?.enabled !== false;
	if (!ctx.isProjectTrusted()) return enabled;
	const projectSettings = readJson(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
	const projectCompaction = projectSettings?.compaction as Record<string, unknown> | undefined;
	if (typeof projectCompaction?.enabled === "boolean") enabled = projectCompaction.enabled;
	return enabled;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function sanitize(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(CONTROL_PATTERN, "").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatLocalPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const relative = path.relative(resolvedHome, resolvedCwd);
	const insideHome = relative === ""
		|| (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	if (!insideHome) return cwd;
	return relative ? `~${path.sep}${relative}` : "~";
}

function alignColumns(left: string, right: string, width: number): string {
	if (!right || width < 20) return truncateToWidth(left, width, "...");
	const maxRightWidth = Math.max(10, Math.floor(width * 0.45));
	const compactRight = truncateToWidth(right, maxRightWidth, "");
	const rightWidth = visibleWidth(compactRight);
	const leftWidth = Math.max(1, width - rightWidth - 2);
	const compactLeft = truncateToWidth(left, leftWidth, "...");
	const padding = " ".repeat(Math.max(1, width - visibleWidth(compactLeft) - rightWidth));
	return truncateToWidth(compactLeft + padding + compactRight, width, "");
}

function targetColumns(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	colors: FooterColors,
	thinkingLevel: ThinkingLevel,
): { left: string; right: string } {
	const rawSshStatus = footerData.getExtensionStatuses().get("ssh-remote");
	const sshStatus = rawSshStatus ? sanitize(stripAnsi(rawSshStatus)) : undefined;
	let left: string;
	if (sshStatus?.startsWith("SSH: ")) {
		left = `${paint(theme, colors.ssh, "SSH")} ${paint(theme, colors.path, sshStatus.slice(5))}`;
	} else if (sshStatus?.startsWith("SSH failed: ")) {
		left = `${paint(theme, colors.context.error, "SSH!")} ${paint(theme, colors.path, sshStatus.slice(12))}`;
	} else {
		const branch = footerData.getGitBranch();
		left = `${paint(theme, colors.local, "LOCAL")} ${paint(theme, colors.path, formatLocalPath(ctx.sessionManager.getCwd()))}`;
		if (branch) left += ` ${paint(theme, colors.branch, `(${branch})`)}`;
	}
	const rawPresetStatus = footerData.getExtensionStatuses().get("preset");
	if (rawPresetStatus) left += ` ${theme.fg("dim", "•")} ${theme.fg("accent", sanitize(stripAnsi(rawPresetStatus)))}`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) {
		left += ` ${theme.fg("dim", "•")} ${paint(theme, colors.session, sanitize(stripAnsi(sessionName)))}`;
	}

	const modelName = ctx.model?.id ?? "no-model";
	let right = paint(theme, colors.model, modelName);
	if (ctx.model?.reasoning) {
		right += ` ${theme.fg("dim", "•")} ${paint(theme, colors.thinking[thinkingLevel], thinkingLevel)}`;
	}
	return { left, right };
}

function statsColumns(
	ctx: ExtensionContext,
	theme: Theme,
	colors: FooterColors,
	autoCompaction: boolean,
): { left: string; right: string } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost.total;
		const latestPrompt = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = latestPrompt > 0 ? usage.cacheRead / latestPrompt * 100 : undefined;
	}

	const parts = [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`];
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	const subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (cost || subscription) parts.push(`$${cost.toFixed(3)}${subscription ? "(sub)" : ""}`);
	const left = theme.fg("dim", parts.join(" "));

	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage?.percent;
	const display = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
	const color = percent !== null && percent !== undefined && percent > 90
		? colors.context.error
		: percent !== null && percent !== undefined && percent > 70
			? colors.context.warning
			: colors.context.normal;
	let right = `${theme.fg("dim", "ctx ")}${paint(theme, color, `${display}/${formatTokens(contextWindow)}`)}`;
	if (autoCompaction) right += theme.fg("dim", " auto");
	return { left, right };
}

function installFooter(
	ctx: ExtensionContext,
	colors: FooterColors,
	autoCompaction: boolean,
	thinkingLevel: () => ThinkingLevel,
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const target = targetColumns(ctx, footerData, theme, colors, thinkingLevel());
				const stats = statsColumns(ctx, theme, colors, autoCompaction);
				const lines = [
					alignColumns(target.left, target.right, width),
					alignColumns(stats.left, stats.right, width),
				];
				const additionalStatuses = [...footerData.getExtensionStatuses().entries()]
					.filter(([key]) => key !== "ssh-remote" && key !== "preset")
					.map(([, value]) => sanitize(value));
				if (additionalStatuses.length > 0) {
					lines.push(truncateToWidth(additionalStatuses.join(" "), width, theme.fg("dim", "...")));
				}
				return lines;
			},
		};
	});
}

export default function customFooter(pi: ExtensionAPI): void {
	let colors = structuredClone(DEFAULT_FOOTER_COLORS);
	let autoCompaction = true;

	const loadAndInstall = (ctx: ExtensionContext) => {
		const configPath = footerColorsPath();
		const loaded = loadColors(configPath);
		colors = loaded.colors;
		autoCompaction = compactionEnabled(ctx);
		installFooter(ctx, colors, autoCompaction, () => pi.getThinkingLevel() as ThinkingLevel);
		if (loaded.error) ctx.ui.notify(`Footer color config is invalid; using defaults: ${loaded.error}`, "warning");
	};

	pi.on("session_start", async (_event, ctx) => loadAndInstall(ctx));
	pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setFooter(undefined));

	pi.registerCommand("footer-colors", {
		description: "Show the custom footer color configuration path",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Footer color config: ${footerColorsPath()}\nCreate or edit this JSON file, then run /reload.`, "info");
		},
	});
}
