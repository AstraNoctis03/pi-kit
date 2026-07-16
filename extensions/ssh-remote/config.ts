export interface ParsedSshTarget {
	host: string;
	remoteCwd?: string;
}

const SAFE_HOST = /^(?!-)[A-Za-z0-9_.@-]+$/;

export function parseSshTarget(value: string): ParsedSshTarget {
	const trimmed = value.trim();
	const pathSeparator = trimmed.indexOf(":/");
	const host = pathSeparator >= 0 ? trimmed.slice(0, pathSeparator) : trimmed;
	const remoteCwd = pathSeparator >= 0 ? trimmed.slice(pathSeparator + 1) : undefined;

	if (!SAFE_HOST.test(host)) {
		throw new Error("SSH target must be an SSH config alias or user@host without spaces.");
	}
	if (remoteCwd?.includes("\0")) throw new Error("Remote working directory contains a NUL byte.");
	return { host, remoteCwd };
}

export function findPathPatterns(root: string, pattern: string): string[] {
	const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/")) {
		throw new Error("Find pattern must be a non-empty relative glob.");
	}
	if (!normalized.includes("/")) return [normalized];

	const collapsed = normalized.replace(/^\*\*\//, "").replace(/\/\*\*\//g, "/");
	return [...new Set([normalized, collapsed])].map((candidate) => `${root.replace(/\/$/, "")}/${candidate}`);
}
