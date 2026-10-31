import { keyHint, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { displayText } from "./ansi.ts";
import { dimensions, duration, record, RESET, type ToolRenderers, type ViewContext } from "./layout.ts";

interface SearchEntry { rank: string; title: string; url?: string }

// Read only our own formatter's numbered headings and URL fields. No API/result
// changes, status inference, result reordering or network work in the renderer.
function entries(text: string): SearchEntry[] {
	if (!text.startsWith("Exa search results for: ")) return [];
	const result: SearchEntry[] = [];
	for (const line of text.split("\n")) {
		const heading = /^(\d+)\. (.+)$/.exec(line);
		if (heading) result.push({ rank: heading[1], title: heading[2] });
		else if (line.startsWith("   URL: ") && result.length) result[result.length - 1].url = line.slice(8);
	}
	return result;
}

function query(args: unknown): string {
	const value = record(args)?.query;
	return typeof value === "string" ? displayText(value) : "";
}

function queryPreview(args: unknown, context: ViewContext, width: number) {
	const source = query(args);
	const { room } = dimensions(width, context);
	const status = context.isPartial ? context.executionStarted ? "搜索中" : "准备中" : duration(context.durationMs);
	const meta = status && room >= visibleWidth("✓ Exa Search") + visibleWidth(status) + 7 ? status : "";
	const budget = Math.max(0, Math.min(48, room - visibleWidth("✓ Exa Search") - 3 - (meta ? visibleWidth(meta) + 3 : 0)));
	const first = source.split("\n")[0] || "…";
	return { meta, preview: truncateToWidth(first, budget, "…"), hidden: source.includes("\n") || visibleWidth(first) > budget };
}

function shortUrl(source: string): string {
	try {
		const url = new URL(source);
		if (url.protocol === "https:" || url.protocol === "http:") return url.host + url.pathname + url.search + url.hash;
	} catch { /* Unknown formats stay literal text, never clickable terminal controls. */ }
	return source;
}

class SearchCallView implements Component {
	private args: unknown;
	private theme!: Theme;
	private context!: ViewContext;
	update(args: unknown, theme: Theme, context: ViewContext): this {
		this.args = args; this.theme = theme; this.context = context;
		return this;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const { theme, context } = this;
		const { margin, room } = dimensions(width, context);
		const summary = queryPreview(this.args, context, width);
		const color = context.isPartial ? "warning" : context.isError ? "error" : "success";
		const icon = context.isPartial ? "◌" : context.isError ? "✗" : "✓";
		let title = theme.fg(color, icon) + " " + theme.fg("toolTitle", theme.bold("Exa Search"));
		if (!context.expanded) title += theme.fg("muted", ` · ${summary.preview}`);
		if (summary.meta) title += theme.fg("muted", ` · ${summary.meta}`);
		const lines = [margin + truncateToWidth(title, room, "…") + RESET];
		if (context.expanded) {
			const body = dimensions(width, context, 2);
			// Keep every original filter/option available without inventing summaries.
			const args = displayText(JSON.stringify(this.args, null, 2) ?? "");
			for (const line of wrapTextWithAnsi(theme.fg("muted", args), body.room)) lines.push(body.margin + truncateToWidth(line, body.room, "…") + RESET);
		}
		return lines;
	}
}

class SearchResultView implements Component {
	private text = "";
	private items: SearchEntry[] = [];
	private count: number | undefined;
	private cost: number | undefined;
	private truncated = false;
	private theme!: Theme;
	private context!: ViewContext;
	private cache: { width: number; lines: string[] } | undefined;
	update(result: AgentToolResult<unknown>, theme: Theme, context: ViewContext): this {
		const text = displayText(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).replace(/\n$/, "");
		if (text !== this.text) this.items = entries(text);
		const details = record(result.details);
		this.count = typeof details?.resultCount === "number" && Number.isSafeInteger(details.resultCount) && details.resultCount >= 0 ? details.resultCount : undefined;
		this.cost = typeof details?.costDollars === "number" && Number.isFinite(details.costDollars) && details.costDollars >= 0 ? details.costDollars : undefined;
		this.truncated = details?.truncated === true;
		this.text = text; this.theme = theme; this.context = context; this.cache = undefined;
		return this;
	}
	invalidate(): void { this.cache = undefined; }
	render(width: number): string[] {
		if (width < 1) return [];
		if (this.cache?.width === width) return this.cache.lines;
		const { theme, context } = this;
		const { margin, room } = dimensions(width, context, 2);
		const lines: string[] = [];
		const add = (text: string) => lines.push(margin + truncateToWidth(text, room, "…") + RESET);
		const success = !context.isError && !context.isPartial;
		if (success) {
			const meta = [this.count !== undefined ? `${this.count} 条结果` : "", this.cost !== undefined ? `$${this.cost.toFixed(4)}` : ""].filter(Boolean).join(" · ");
			if (meta) add(theme.fg("muted", meta));
		}
		let hidden = false;
		if (success && !context.expanded && this.items.length) {
			for (const item of this.items.slice(0, 3)) {
				add(theme.fg("text", `${item.rank}. ${item.title}`));
				if (item.url) add(theme.fg("muted", "   " + shortUrl(item.url)));
			}
			hidden = true; // The original highlights, dates and notices remain behind expansion.
		} else if (success && !context.expanded && this.count === 0 && this.text.startsWith("Exa search results for: ")) {
			add(theme.fg("muted", "未找到结果"));
			hidden = true;
		} else {
			const body = this.text ? wrapTextWithAnsi(theme.fg(context.isError ? "error" : "text", this.text), room) : [];
			const nonBlank = body.filter((line) => stripTerminalSequences(line).trim());
			let preview = context.expanded ? body : nonBlank.slice(0, context.isError ? 6 : 3);
			if (!context.expanded && context.isError && nonBlank.length > 6) preview = [...nonBlank.slice(0, 2), theme.fg("muted", "…"), ...nonBlank.slice(-3)];
			for (const line of preview) add(line);
			hidden = body.length > preview.length;
		}
		if (this.truncated) {
			for (const line of wrapTextWithAnsi(theme.fg("warning", "工具结果已截断；展开仅显示已返回内容"), room)) add(line);
		}
		if (!context.expanded && (hidden || queryPreview(context.args, context, width).hidden)) add(keyHint("app.tools.expand", "展开"));
		this.cache = { width, lines };
		return lines;
	}
}

export const exaRenderers: ToolRenderers = {
	renderShell: "self",
	renderCall(args, theme, context) {
		return (context.lastComponent instanceof SearchCallView ? context.lastComponent : new SearchCallView()).update(args, theme, context);
	},
	renderResult(result, options, theme, context) {
		return (context.lastComponent instanceof SearchResultView ? context.lastComponent : new SearchResultView())
			.update(result, theme, { ...context, expanded: options.expanded, isPartial: options.isPartial });
	},
};
