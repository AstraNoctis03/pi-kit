import { getLanguageFromPath, highlightCode, keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getImageDimensions, imageFallback, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { displayText } from "./ansi.ts";
import { dimensions, duration, record, RESET, type ToolRenderers, type ViewContext } from "./layout.ts";

type Kind = "read" | "edit" | "write";

function filePath(args: unknown): string {
	const value = record(args)?.path ?? record(args)?.file_path;
	return typeof value === "string" ? displayText(value) : "";
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function requestedRange(args: unknown): string {
	const input = record(args);
	if (input?.offset == null && input?.limit == null) return "";
	const start = positiveInteger(input?.offset ?? 1);
	if (start === undefined) return "";
	if (input?.limit == null) return `L${start}`;
	const count = positiveInteger(input.limit);
	if (count === undefined || !Number.isSafeInteger(start + count - 1)) return "";
	return `L${start}–${start + count - 1}`; // Requested range, not a claim about EOF.
}

function titleParts(kind: Kind, args: unknown, context: ViewContext, width: number) {
	const path = filePath(args);
	const label = { read: "Read", edit: "Edit", write: "Write" }[kind];
	// Host-started includes approval hooks, not necessarily Write file I/O.
	const phase = context.isPartial ? context.executionStarted ? { read: "读取中", edit: "编辑中", write: "处理中" }[kind] : "准备中" : duration(context.durationMs);
	const metadata = [kind === "read" ? requestedRange(args) : "", phase].filter(Boolean).join(" · ");
	const { room } = dimensions(width, context);
	const meta = metadata && room >= visibleWidth(label) + visibleWidth(metadata) + 7 ? metadata : "";
	const budget = Math.max(0, Math.min(48, room - visibleWidth(label) - 5 - (meta ? visibleWidth(meta) + 3 : 0)));
	const singleLine = path.replace(/\n/g, "↵") || "…";
	const hidden = path.includes("\n") || visibleWidth(singleLine) > budget;
	const preview = budget < 1 ? "" : visibleWidth(singleLine) <= budget ? singleLine
		: "…" + sliceByColumn(singleLine, Math.max(0, visibleWidth(singleLine) - budget + 1), budget - 1, true);
	return { label, path, preview, hidden, meta };
}

class FileCallView implements Component {
	readonly kind: Kind;
	private args: unknown;
	private theme!: Theme;
	private context!: ViewContext;
	constructor(kind: Kind) { this.kind = kind; }
	update(args: unknown, theme: Theme, context: ViewContext): this {
		this.args = args; this.theme = theme; this.context = context;
		return this;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const { theme, context } = this;
		const title = titleParts(this.kind, this.args, context, width);
		const { margin, room } = dimensions(width, context);
		const color = context.isPartial ? "warning" : context.isError ? "error" : "success";
		const icon = context.isPartial ? "◌" : context.isError ? "✗" : "✓";
		let heading = theme.fg(color, icon) + " " + theme.fg("toolTitle", theme.bold(title.label));
		if (!context.expanded && title.preview) heading += theme.fg("accent", ` · ${title.preview}`);
		if (title.meta) heading += theme.fg("muted", ` · ${title.meta}`);
		const lines = [margin + truncateToWidth(heading, room, "…") + RESET];
		if (context.expanded && title.path) {
			const body = dimensions(width, context, 2);
			for (const line of wrapTextWithAnsi(theme.fg("accent", title.path), body.room)) lines.push(body.margin + truncateToWidth(line, body.room, "…") + RESET);
		}
		return lines;
	}
}

class FileResultView implements Component {
	readonly kind: Kind;
	private text = "";
	private diff = "";
	private submitted = "";
	private path = "";
	private truncated = false;
	private content: AgentToolResult<unknown>["content"] = [];
	private theme!: Theme;
	private context!: ViewContext;
	private styled: string | undefined;
	private inlineImages = false;
	private cache: { width: number; lines: string[] } | undefined;
	constructor(kind: Kind) { this.kind = kind; }

	update(result: AgentToolResult<unknown>, theme: Theme, context: ViewContext): this {
		const text = displayText(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).replace(/\n$/, "");
		const details = record(result.details);
		const diff = this.kind === "edit" && !context.isError && !context.isPartial && typeof details?.diff === "string" ? displayText(details.diff) : "";
		const input = this.kind === "write" && !context.isError && !context.isPartial ? record(context.args)?.content : undefined;
		const submitted = typeof input === "string" ? displayText(input).replace(/\n$/, "") : "";
		const path = filePath(context.args);
		if (text !== this.text || diff !== this.diff || submitted !== this.submitted || path !== this.path || theme !== this.theme || result.content !== this.content
			|| context.isError !== this.context?.isError || context.showImages !== this.context?.showImages) this.styled = undefined;
		this.text = text; this.diff = diff; this.submitted = submitted; this.path = path; this.content = result.content;
		this.truncated = record(details?.truncation)?.truncated === true;
		this.theme = theme; this.context = context; this.cache = undefined;
		return this;
	}

	invalidate(): void { this.styled = undefined; this.cache = undefined; }

	private body(): string {
		if (this.styled !== undefined) return this.styled;
		const { theme, context } = this;
		if (this.diff) {
			// Pure native diff painting only. Never invoke edit's native renderCall:
			// it computes a preview by reading local files, even in an SSH session.
			this.styled = renderDiff(this.diff, { filePath: this.path });
		} else {
			let text = this.text;
			if (!this.inlineImages) {
				const images = this.content.filter((part) => part.type === "image").map((image) =>
					displayText(imageFallback(image.mimeType, getImageDimensions(image.data, image.mimeType) ?? undefined)));
				text = [text, ...images].filter(Boolean).join("\n");
			}
			const language = this.kind === "read" && !context.isError ? getLanguageFromPath(this.path) : undefined;
			this.styled = language && text.length <= 16_384 ? highlightCode(text, language).join("\n") : theme.fg(context.isError ? "error" : "text", text);
			if (this.submitted) {
				// Preview the submitted input only after final success, never as a
				// read-back or a diff. Keep the original tool result after the content.
				const language = getLanguageFromPath(this.path);
				const source = language && this.submitted.length <= 16_384 ? highlightCode(this.submitted, language).join("\n") : theme.fg("text", this.submitted);
				this.styled = source + (text ? "\n" + this.styled : "");
			}
		}
		return this.styled;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const inlineImages = Boolean(getCapabilities().images && this.context.showImages);
		if (inlineImages !== this.inlineImages) { this.inlineImages = inlineImages; this.invalidate(); }
		if (this.cache?.width === width) return this.cache.lines;
		const { theme, context } = this;
		const { margin, room } = dimensions(width, context, 2);
		const source = this.body();
		const logical = source.split("\n");
		const lines: string[] = [];
		let start = 0;
		if (this.diff) {
			let added = 0; let removed = 0;
			const raw = this.diff.split("\n");
			// Count only native display-diff records, not requested replacements or
			// unified-patch headers (a source line itself can begin with +++/---).
			for (const line of raw) {
				if (/^\+\s*\d+\s/.test(line)) added++;
				if (/^-\s*\d+\s/.test(line)) removed++;
			}
			if (added || removed) {
				const stats = [added ? theme.fg("toolDiffAdded", `+${added}`) : "", removed ? theme.fg("toolDiffRemoved", `−${removed}`) : ""].filter(Boolean).join(" ");
				lines.push(margin + truncateToWidth(stats, room, "…") + RESET);
			}
			if (!context.expanded) start = Math.max(0, raw.findIndex((line) => /^[+-]\s*\d+\s/.test(line)) - 1);
		}
		const body = stripTerminalSequences(source).length ? wrapTextWithAnsi(logical.slice(start).join("\n"), room) : [];
		const limit = context.isError || this.kind === "edit" ? 6 : 3;
		let preview = context.expanded ? body : body.slice(0, limit);
		if (!context.expanded && context.isError) {
			const nonBlank = body.filter((line) => stripTerminalSequences(line).trim());
			preview = nonBlank.length > limit ? [...nonBlank.slice(0, 2), theme.fg("muted", "…"), ...nonBlank.slice(-3)] : nonBlank;
		}
		for (const line of preview) lines.push(margin + truncateToWidth(line, room, "…") + RESET);
		if (this.truncated) {
			for (const line of wrapTextWithAnsi(theme.fg("warning", "工具结果已截断；展开仅显示已返回内容"), room)) lines.push(margin + truncateToWidth(line, room, "…") + RESET);
		}
		if (!context.expanded && (start > 0 || body.length > preview.length || titleParts(this.kind, context.args, context, width).hidden)) {
			const hint = keyHint("app.tools.expand", "展开");
			lines.push(margin + truncateToWidth(hint, room, "…") + RESET);
		}
		this.cache = { width, lines };
		return lines;
	}
}

function createFileRenderers(kind: Kind): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			return (context.lastComponent instanceof FileCallView && context.lastComponent.kind === kind ? context.lastComponent : new FileCallView(kind)).update(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return (context.lastComponent instanceof FileResultView && context.lastComponent.kind === kind ? context.lastComponent : new FileResultView(kind))
				.update(result, theme, { ...context, expanded: options.expanded, isPartial: options.isPartial });
		},
	};
}

export const readRenderers = createFileRenderers("read");
export const editRenderers = createFileRenderers("edit");
export const writeRenderers = createFileRenderers("write");
