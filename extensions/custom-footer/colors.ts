import type { Theme } from "@earendil-works/pi-coding-agent";

export type ColorValue = string | number;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface FooterColors {
	path: ColorValue;
	ssh: ColorValue;
	branch: ColorValue;
	model: ColorValue;
	thinking: Record<ThinkingLevel, ColorValue>;
	context: {
		normal: ColorValue;
		warning: ColorValue;
		error: ColorValue;
	};
}

export const DEFAULT_FOOTER_COLORS: FooterColors = {
	path: "#67e8f9",
	ssh: "#f59e0b",
	branch: "#4ade80",
	model: "#c4b5fd",
	thinking: {
		off: "#6b7280",
		minimal: "#93c5fd",
		low: "#38bdf8",
		medium: "#34d399",
		high: "#fbbf24",
		xhigh: "#fb923c",
		max: "#f87171",
	},
	context: {
		normal: "#4ade80",
		warning: "#fbbf24",
		error: "#f87171",
	},
};

export function isColorValue(value: unknown): value is ColorValue {
	return (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
		|| (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
}

function mergeColor(current: ColorValue, value: unknown): ColorValue {
	return isColorValue(value) ? value : current;
}

export function mergeFooterColors(value: unknown): FooterColors {
	if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(DEFAULT_FOOTER_COLORS);
	const input = value as Record<string, unknown>;
	const thinking = input.thinking && typeof input.thinking === "object" && !Array.isArray(input.thinking)
		? input.thinking as Record<string, unknown>
		: {};
	const context = input.context && typeof input.context === "object" && !Array.isArray(input.context)
		? input.context as Record<string, unknown>
		: {};
	const defaults = DEFAULT_FOOTER_COLORS;

	return {
		path: mergeColor(defaults.path, input.path),
		ssh: mergeColor(defaults.ssh, input.ssh),
		branch: mergeColor(defaults.branch, input.branch),
		model: mergeColor(defaults.model, input.model),
		thinking: {
			off: mergeColor(defaults.thinking.off, thinking.off),
			minimal: mergeColor(defaults.thinking.minimal, thinking.minimal),
			low: mergeColor(defaults.thinking.low, thinking.low),
			medium: mergeColor(defaults.thinking.medium, thinking.medium),
			high: mergeColor(defaults.thinking.high, thinking.high),
			xhigh: mergeColor(defaults.thinking.xhigh, thinking.xhigh),
			max: mergeColor(defaults.thinking.max, thinking.max),
		},
		context: {
			normal: mergeColor(defaults.context.normal, context.normal),
			warning: mergeColor(defaults.context.warning, context.warning),
			error: mergeColor(defaults.context.error, context.error),
		},
	};
}

export function paint(theme: Theme, color: ColorValue, text: string): string {
	if (typeof color === "number") return `\x1b[38;5;${color}m${text}\x1b[39m`;
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	if (![red, green, blue].every(Number.isFinite)) return theme.fg("text", text);
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
