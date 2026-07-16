import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SensitivePathRules {
	allow: string[];
	block: string[];
	confirm: string[];
}

export const DEFAULT_SENSITIVE_PATH_RULES: SensitivePathRules = {
	allow: [
		"**/.env.example",
		"**/.env.sample",
		"**/.env.template",
	],
	block: [
		"**/.git",
		"**/.git/**",
		"**/*.pem",
		"**/*.key",
		"**/*.p12",
		"**/*.pfx",
		"**/id_rsa",
		"**/id_dsa",
		"**/id_ecdsa",
		"**/id_ed25519",
	],
	confirm: [
		"**/.env",
		"**/.env.*",
		"**/credentials",
		"**/credentials.*",
		"**/secret",
		"**/secret.*",
		"**/secrets",
		"**/secrets.*",
	],
};

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	let expression = "^";
	for (let index = 0; index < normalized.length; index += 1) {
		const character = normalized[index];
		if (character === "*" && normalized[index + 1] === "*") {
			if (normalized[index + 2] === "/") {
				expression += "(?:.*/)?";
				index += 2;
			} else {
				expression += ".*";
				index += 1;
			}
		} else if (character === "*") {
			expression += "[^/]*";
		} else if (character === "?") {
			expression += "[^/]";
		} else {
			expression += escapeRegex(character);
		}
	}
	return new RegExp(`${expression}$`, "i");
}

export function normalizeGuardPath(value: string): string {
	return value.trim().replace(/^@/, "").replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function sensitivePathCandidates(pathname: string, cwd: string): string[] {
	const normalized = normalizeGuardPath(pathname);
	const expanded = normalized === "~"
		? homedir()
		: normalized.startsWith("~/")
			? path.join(homedir(), normalized.slice(2))
			: normalized;
	const absolute = path.resolve(cwd, expanded);
	const suffix: string[] = [];
	let existing = absolute;
	let canonical: string | undefined;
	while (true) {
		try {
			canonical = path.join(realpathSync.native(existing), ...suffix);
			break;
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) break;
			suffix.unshift(path.basename(existing));
			existing = parent;
		}
	}
	return canonical && normalizeGuardPath(canonical) !== normalized
		? [pathname, canonical]
		: [pathname];
}

function matchesAny(pathname: string, patterns: string[]): string | undefined {
	return patterns.find((pattern) => globToRegExp(pattern).test(pathname));
}

export function classifySensitivePath(
	pathname: string,
	rules: SensitivePathRules = DEFAULT_SENSITIVE_PATH_RULES,
): { action: "block" | "confirm"; pattern: string } | undefined {
	const normalized = normalizeGuardPath(pathname);
	if (matchesAny(normalized, rules.allow)) return undefined;
	const blocked = matchesAny(normalized, rules.block);
	if (blocked) return { action: "block", pattern: blocked };
	const confirmed = matchesAny(normalized, rules.confirm);
	return confirmed ? { action: "confirm", pattern: confirmed } : undefined;
}

function parseRules(value: unknown): Partial<SensitivePathRules> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const result: Partial<SensitivePathRules> = {};
	for (const key of ["allow", "block", "confirm"] as const) {
		if (Array.isArray(input[key]) && input[key].every((item) => typeof item === "string")) {
			result[key] = input[key].map((item) => item.trim()).filter(Boolean);
		}
	}
	return result;
}

function readRules(pathname: string): { rules: Partial<SensitivePathRules>; error?: string } {
	if (!existsSync(pathname)) return { rules: {} };
	try {
		return { rules: parseRules(JSON.parse(readFileSync(pathname, "utf8"))) };
	} catch (error) {
		return { rules: {}, error: `${pathname}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function mergeRules(base: SensitivePathRules, extra: Partial<SensitivePathRules>): SensitivePathRules {
	return {
		allow: [...base.allow, ...(extra.allow ?? [])],
		block: [...base.block, ...(extra.block ?? [])],
		confirm: [...base.confirm, ...(extra.confirm ?? [])],
	};
}

export interface LoadedSensitivePathRules {
	rules: SensitivePathRules;
	errors: string[];
	globalPath: string;
	projectPath: string;
}

export function loadSensitivePathRules(cwd: string, projectTrusted: boolean): LoadedSensitivePathRules {
	const globalPath = path.join(getAgentDir(), "sensitive-paths.json");
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "sensitive-paths.json");
	const global = readRules(globalPath);
	const project = projectTrusted ? readRules(projectPath) : { rules: {} };
	return {
		rules: mergeRules(mergeRules(DEFAULT_SENSITIVE_PATH_RULES, global.rules), project.rules),
		errors: [global.error, project.error].filter((error): error is string => Boolean(error)),
		globalPath,
		projectPath,
	};
}
