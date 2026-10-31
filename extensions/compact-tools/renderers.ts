import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import type { createBashToolDefinition, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { displayText } from "./ansi.ts";
import { dimensions, duration, record, RESET } from "./layout.ts";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;
export type BashRenderers = Pick<BashDefinition, "renderShell" | "renderCall" | "renderResult">;
type Result = Parameters<NonNullable<BashRenderers["renderResult"]>>[0];
type Context = Parameters<NonNullable<BashRenderers["renderCall"]>>[2] & { durationMs?: number; outputPad?: number };
const PREVIEW_LINES = 3;
const ERROR_PREVIEW_LINES = 6;
const COMMAND_PREVIEW_COLUMNS = 48;
function command(args: unknown): string {
	const value = record(args)?.command;
	return typeof value === "string" ? displayText(value) : "";
}

// Both slots use the same width budget; only the result slot draws the single
// expansion hint. No shared mutable renderer state or executor hooks are needed.
function commandSummary(source: string, context: Context, width: number) {
	const { room } = dimensions(width, context);
	const status = context.isPartial ? context.executionStarted ? "运行中" : "准备中" : duration(context.durationMs);
	const labelWidth = visibleWidth("✓ Bash");
	const meta = status && room >= labelWidth + visibleWidth(status) + (context.expanded ? 3 : 9) ? status : "";
	const budget = Math.max(0, Math.min(COMMAND_PREVIEW_COLUMNS, room - labelWidth - 3 - (meta ? visibleWidth(meta) + 3 : 0)));
	const first = source.split("\n")[0] || (source ? "(首行为空)" : context.argsComplete ? "(空命令)" : "等待命令…");
	return {
		meta,
		preview: budget ? truncateToWidth(first, budget, "…") : "",
		hidden: source.includes("\n") || (source.length > 0 && visibleWidth(first) > budget),
		lines: source ? source.split("\n").length : 0,
	};
}

class CallView implements Component {
	private source = "";
	private colored: string[] | undefined;
	private timeout: number | undefined;
	private theme!: Theme;
	private context!: Context;

	update(args: unknown, theme: Theme, context: Context): this {
		const source = command(args);
		if (source !== this.source || theme !== this.theme) this.colored = undefined;
		this.source = source;
		const timeout = record(args)?.timeout;
		this.timeout = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
		this.theme = theme;
		this.context = context;
		return this;
	}

	invalidate(): void { this.colored = undefined; }

	render(width: number): string[] {
		if (width < 1) return [];
		const { theme, context } = this;
		const { margin, room } = dimensions(width, context);
		const pending = context.isPartial;
		const color = pending ? "warning" : context.isError ? "error" : "success";
		const icon = pending ? "◌" : context.isError ? "✗" : "✓";
		const label = theme.fg(color, icon) + " " + theme.fg("toolTitle", theme.bold("Bash"));
		const summary = commandSummary(this.source, context, width);
		let heading = label;
		if (!context.expanded && summary.preview) heading += theme.fg("muted", ` · ${summary.preview}`);
		if (summary.meta) heading += theme.fg("muted", ` · ${summary.meta}`);
		const lines = [margin + truncateToWidth(heading, room, "…") + RESET];
		const body = dimensions(width, context, 2);
		if (context.expanded) {
			// Keep detailed Shell colors behind expansion, not across the header.
			this.colored ??= this.source.length <= 16_384 ? highlightCode(this.source, "bash") : this.source.split("\n");
			for (const line of wrapTextWithAnsi(theme.fg("toolTitle", this.colored.join("\n")), body.room)) {
				lines.push(body.margin + truncateToWidth(line, body.room, "…") + RESET);
			}
			if (this.timeout !== undefined) {
				lines.push(body.margin + truncateToWidth(theme.fg("muted", `超时上限 ${this.timeout}s`), body.room, "…") + RESET);
			}
		}
		return lines;
	}
}

class ResultView implements Component {
	private text = "";
	private source = "";
	private notice = "";
	private theme!: Theme;
	private context!: Context;
	private cache: { width: number; lines: string[] } | undefined;

	update(result: Result, theme: Theme, context: Context): this {
		let output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const path = result.details?.fullOutputPath;
		const truncated = result.details?.truncation?.truncated;
		// Native Bash appends a truncation footer to content. Keep its information
		// in a separate always-visible notice, not in place of the output preview.
		if (truncated && path && output.endsWith("]")) {
			const footer = output.lastIndexOf("\n\n[");
			if (footer >= 0 && output.slice(footer).includes(path)) output = output.slice(0, footer);
		}
		const text = displayText(output, true).replace(/\n$/, "");
		const source = command(context.args);
		const notice = truncated || path ? displayText(`${truncated ? "工具结果已截断" : ""}${path ? `${truncated ? " · " : ""}完整日志: ${path}` : ""}`) : "";
		if (text !== this.text || notice !== this.notice || source !== this.source || theme !== this.theme
			|| context.expanded !== this.context?.expanded || context.isError !== this.context?.isError
			|| context.outputPad !== this.context?.outputPad || context.durationMs !== this.context?.durationMs
			|| context.isPartial !== this.context?.isPartial || context.executionStarted !== this.context?.executionStarted) this.cache = undefined;
		this.text = text; this.source = source; this.notice = notice; this.theme = theme; this.context = context;
		return this;
	}

	invalidate(): void { this.cache = undefined; }

	render(width: number): string[] {
		if (width < 1) return [];
		if (this.cache?.width === width) return this.cache.lines;
		const { theme, context } = this;
		const { margin, room } = dimensions(width, context, 2);
		const output = this.text ? wrapTextWithAnsi(theme.fg(context.isError ? "error" : "text", this.text), room) : [];
		const nonBlank = output.filter((line) => stripTerminalSequences(line).trim().length > 0);
		let preview = context.expanded ? output : nonBlank.slice(-(context.isError ? ERROR_PREVIEW_LINES : PREVIEW_LINES));
		let kept = preview.length;
		if (!context.expanded && context.isError && nonBlank.length > ERROR_PREVIEW_LINES) {
			// Keep the first error context as well as the final exception/exit lines.
			preview = [...nonBlank.slice(0, 2), theme.fg("muted", "…"), ...nonBlank.slice(-3)];
			kept = 5;
		}
		const lines = preview.map((line) => margin + truncateToWidth(line, room, "…") + RESET);
		if (this.notice) {
			for (const line of wrapTextWithAnsi(theme.fg("warning", this.notice), room)) lines.push(margin + truncateToWidth(line, room, "…") + RESET);
		}
		if (!context.expanded) {
			const summary = commandSummary(this.source, context, width);
			const hidden: string[] = [];
			if (summary.hidden) hidden.push(summary.lines > 1 ? `${summary.lines} 行命令` : "长命令");
			if (output.length > kept) hidden.push(`${this.text.split("\n").length} 行输出`);
			if (hidden.length) {
				const hint = theme.fg("muted", `${hidden.join(" · ")} · `) + keyHint("app.tools.expand", "展开");
				lines.push(margin + truncateToWidth(hint, room, "…") + RESET);
			}
		}
		this.cache = { width, lines };
		return lines;
	}
}

export const bashRenderers: BashRenderers = {
	renderShell: "self",
	renderCall(args, theme, context) {
		return (context.lastComponent instanceof CallView ? context.lastComponent : new CallView()).update(args, theme, context);
	},
	renderResult(result, _options, theme, context) {
		return (context.lastComponent instanceof ResultView ? context.lastComponent : new ResultView()).update(result, theme, context);
	},
};
