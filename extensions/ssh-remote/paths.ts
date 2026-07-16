import { homedir } from "node:os";
import path from "node:path";

function isInside(root: string, value: string): string | undefined {
	const relative = path.relative(root, value);
	if (relative === "") return "";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative;
}

function joinRemote(root: string, relative: string): string {
	return path.posix.resolve(root, relative.split(path.sep).join("/"));
}

function isInsideRemote(root: string, value: string): string | undefined {
	const relative = path.posix.relative(root, value);
	if (relative === "") return "";
	if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return undefined;
	return relative;
}

export function syntheticRemoteCwd(localCwd: string): string {
	return path.resolve(localCwd, ".pi-ssh-remote-workspace");
}

export class RemotePathMapper {
	readonly remoteCwd: string;
	readonly remoteHome: string;
	readonly syntheticCwd: string;
	private readonly localHome = homedir();

	constructor(localCwd: string, remoteCwd: string, remoteHome: string) {
		this.remoteCwd = remoteCwd;
		this.remoteHome = remoteHome;
		this.syntheticCwd = syntheticRemoteCwd(localCwd);
	}

	resolveRemoteInput(input: string): string {
		const value = input.trim().replace(/^@/, "");
		if (!value || value === ".") return this.remoteCwd;
		if (value === "~") return this.remoteHome;
		if (value.startsWith("~/")) return path.posix.resolve(this.remoteHome, value.slice(2));
		if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
		return path.posix.resolve(this.remoteCwd, value.replace(/\\/g, "/"));
	}

	toRemotePath(toolPath: string): string {
		const absolute = path.resolve(toolPath);
		const workspaceRelative = isInside(this.syntheticCwd, absolute);
		if (workspaceRelative !== undefined) return joinRemote(this.remoteCwd, workspaceRelative);

		const homeRelative = isInside(this.localHome, absolute);
		if (homeRelative !== undefined) return joinRemote(this.remoteHome, homeRelative);

		if (process.platform === "win32") {
			if (absolute.startsWith("\\\\")) throw new Error(`UNC paths are not supported in SSH mode: ${toolPath}`);
			const root = path.win32.parse(absolute).root;
			const relative = absolute.slice(root.length).replace(/\\/g, "/");
			return path.posix.resolve("/", relative);
		}
		return absolute;
	}

	toToolPath(remotePath: string): string {
		const normalized = path.posix.normalize(remotePath);
		const workspaceRelative = isInsideRemote(this.remoteCwd, normalized);
		if (workspaceRelative !== undefined) return path.resolve(this.syntheticCwd, ...workspaceRelative.split("/").filter(Boolean));

		const homeRelative = isInsideRemote(this.remoteHome, normalized);
		if (homeRelative !== undefined) return path.resolve(this.localHome, ...homeRelative.split("/").filter(Boolean));

		if (process.platform === "win32") {
			const driveRoot = path.win32.parse(this.syntheticCwd).root;
			return path.win32.resolve(driveRoot, ...normalized.split("/").filter(Boolean));
		}
		return normalized;
	}
}
