import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Preset {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	instructions?: string;
}

export type Presets = Record<string, Preset>;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_PRESETS: Presets = {
	review: {
		thinkingLevel: "high",
		tools: ["read", "bash", "grep", "find", "ls", "exa_search"],
		instructions: "You are in strict review mode. Inspect the requested code and report actionable correctness, security, type-safety, and testing findings. Do not modify files. Bash is restricted to read-only inspection and verification commands; use it for git diff/status/log and focused tests when needed.",
	},
};

function parsePreset(value: unknown): Preset | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const preset: Preset = {};
	if (typeof input.provider === "string" && input.provider.trim()) preset.provider = input.provider.trim();
	if (typeof input.model === "string" && input.model.trim()) preset.model = input.model.trim();
	if (typeof input.thinkingLevel === "string" && THINKING_LEVELS.has(input.thinkingLevel as ThinkingLevel)) {
		preset.thinkingLevel = input.thinkingLevel as ThinkingLevel;
	}
	if (Array.isArray(input.tools) && input.tools.every((tool) => typeof tool === "string")) {
		preset.tools = [...new Set(input.tools.map((tool) => tool.trim()).filter(Boolean))];
	}
	if (typeof input.instructions === "string") preset.instructions = input.instructions.trim();
	return preset;
}

export function parsePresets(value: unknown): Presets {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Presets = {};
	for (const [name, rawPreset] of Object.entries(value)) {
		if (name.toLowerCase() === "normal" || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) continue;
		const preset = parsePreset(rawPreset);
		if (preset) result[name] = preset;
	}
	return result;
}

function readPresets(pathname: string): { presets: Presets; error?: string } {
	if (!existsSync(pathname)) return { presets: {} };
	try {
		return { presets: parsePresets(JSON.parse(readFileSync(pathname, "utf8"))) };
	} catch (error) {
		return { presets: {}, error: `${pathname}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function mergePresets(base: Presets, overrides: Presets): Presets {
	const result: Presets = structuredClone(base);
	for (const [name, preset] of Object.entries(overrides)) result[name] = { ...(result[name] ?? {}), ...preset };
	return result;
}

export interface LoadedPresets {
	presets: Presets;
	errors: string[];
	globalPath: string;
	projectPath: string;
}

export function loadPresets(cwd: string, projectTrusted: boolean): LoadedPresets {
	const globalPath = path.join(getAgentDir(), "presets.json");
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "presets.json");
	const global = readPresets(globalPath);
	const project = projectTrusted ? readPresets(projectPath) : { presets: {} };
	return {
		presets: mergePresets(mergePresets(DEFAULT_PRESETS, global.presets), project.presets),
		errors: [global.error, project.error].filter((error): error is string => Boolean(error)),
		globalPath,
		projectPath,
	};
}
