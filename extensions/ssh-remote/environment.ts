import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const ENVIRONMENT_ENTRY = "pi-kit.session-environment";

export interface SessionEnvironment {
	version: 1;
	kind: "local" | "ssh";
	host: string;
	cwd: string;
}

export type ResumeScope = "environment" | "directory" | "all";

export function isSessionEnvironment(value: unknown): value is SessionEnvironment {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return data.version === 1 && (data.kind === "local" || data.kind === "ssh")
		&& typeof data.host === "string" && !!data.host.trim()
		&& typeof data.cwd === "string" && !!data.cwd.trim();
}

// Environment ownership is session-wide, not branch-relative. The first record wins.
export function readEnvironment(entries: readonly { type: string; customType?: string; data?: unknown }[]): SessionEnvironment | undefined {
	const entry = entries.find((item) => item.type === "custom" && item.customType === ENVIRONMENT_ENTRY);
	return entry && isSessionEnvironment(entry.data) ? entry.data : undefined;
}

export async function readEnvironmentFile(file: string): Promise<SessionEnvironment | undefined> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.includes(ENVIRONMENT_ENTRY)) continue;
			let entry: { type?: string; customType?: string; data?: unknown };
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry?.type === "custom" && entry.customType === ENVIRONMENT_ENTRY) {
				return isSessionEnvironment(entry.data) ? entry.data : undefined;
			}
		}
		return undefined;
	} finally { lines.close(); stream.destroy(); }
}

export function sameEnvironment(left: SessionEnvironment, right: SessionEnvironment): boolean {
	return left.kind === right.kind && left.host.toLowerCase() === right.host.toLowerCase();
}

export function sameDirectory(left: SessionEnvironment, right: SessionEnvironment): boolean {
	if (!sameEnvironment(left, right)) return false;
	if (left.kind === "ssh") return path.posix.normalize(left.cwd) === path.posix.normalize(right.cwd);
	const normalize = (cwd: string) => /^[A-Za-z]:[\\/]/.test(cwd)
		? path.win32.normalize(cwd).toLowerCase() : path.normalize(cwd);
	return normalize(left.cwd) === normalize(right.cwd);
}

export function matchesScope(saved: SessionEnvironment | undefined, current: SessionEnvironment, scope: ResumeScope): boolean {
	if (scope === "all") return true;
	if (!saved) return false;
	return scope === "directory" ? sameDirectory(saved, current) : sameEnvironment(saved, current);
}

export function environmentDescription(environment: SessionEnvironment | undefined): string {
	if (!environment) return "UNKNOWN";
	return `${environment.kind === "ssh" ? "SSH" : "LOCAL"} ${environment.host}:${environment.cwd}`;
}
