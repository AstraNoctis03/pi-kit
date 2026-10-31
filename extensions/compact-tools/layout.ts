import type { Component } from "@earendil-works/pi-tui";

export interface ViewContext {
	args: unknown;
	lastComponent: Component | undefined;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	durationMs?: number;
	outputPad?: number;
}

export const RESET = "\x1b[0m";

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function dimensions(width: number, context: { outputPad?: number }, indent = 0) {
	const pad = Math.min(context.outputPad ?? 1, Math.max(0, Math.floor((width - 1) / 2)));
	const left = Math.min(pad + indent, Math.max(0, width - 1));
	return { margin: " ".repeat(left), room: Math.max(1, width - left - pad) };
}

export function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
