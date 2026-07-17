import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";

export type ConfirmationColorValue = string | number;

export interface ConfirmationColors {
	border: ConfirmationColorValue;
	title: ConfirmationColorValue;
	selected: ConfirmationColorValue;
}

export const DEFAULT_CONFIRMATION_COLORS: ConfirmationColors = {
	border: "#ff9e64",
	title: "#e0af68",
	selected: "#73daca",
};

export function confirmationColorsPath(): string {
	return path.join(getAgentDir(), "confirmation-colors.json");
}

export function isConfirmationColorValue(value: unknown): value is ConfirmationColorValue {
	return (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
		|| (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
}

export function mergeConfirmationColors(value: unknown): ConfirmationColors {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONFIRMATION_COLORS };
	const input = value as Record<string, unknown>;
	return {
		border: isConfirmationColorValue(input.border) ? input.border : DEFAULT_CONFIRMATION_COLORS.border,
		title: isConfirmationColorValue(input.title) ? input.title : DEFAULT_CONFIRMATION_COLORS.title,
		selected: isConfirmationColorValue(input.selected) ? input.selected : DEFAULT_CONFIRMATION_COLORS.selected,
	};
}

export function loadConfirmationColors(): { colors: ConfirmationColors; error?: string } {
	const configPath = confirmationColorsPath();
	if (!existsSync(configPath)) return { colors: { ...DEFAULT_CONFIRMATION_COLORS } };
	try {
		return { colors: mergeConfirmationColors(JSON.parse(readFileSync(configPath, "utf8"))) };
	} catch (error) {
		return {
			colors: { ...DEFAULT_CONFIRMATION_COLORS },
			error: `${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function paintConfirmationColor(theme: Theme, color: ConfirmationColorValue, text: string): string {
	if (typeof color === "number") return `\x1b[38;5;${color}m${text}\x1b[39m`;
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	if (![red, green, blue].every(Number.isFinite)) return theme.fg("warning", text);
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
