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

export function syntheticRemoteCwd(localCwd: string): string {
	return path.resolve(localCwd, ".pi-ssh-remote-workspace");
}

export class RemotePathMapper {
	readonly remoteCwd: string;
	readonly remoteHome: string;
	readonly syntheticCwd: string;
	private readonly localHome = homedir();
	private readonly encodedRoot: string;

	constructor(localCwd: string, remoteCwd: string, remoteHome: string) {
		this.remoteCwd = remoteCwd;
		this.remoteHome = remoteHome;
		this.syntheticCwd = syntheticRemoteCwd(localCwd);
		this.encodedRoot = path.resolve(localCwd, ".pi-ssh-remote-paths");
	}

	resolveRemoteInput(input: string): string {
		const value = input.trim().replace(/^@/, "");
		if (!value || value === ".") return this.remoteCwd;
		if (value === "~") return this.remoteHome;
		if (value.startsWith("~/")) return path.posix.resolve(this.remoteHome, value.slice(2));
		if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
		return path.posix.resolve(this.remoteCwd, value.replace(/\\/g, "/"));
	}

	// Interpret user input on the remote before a built-in tool normalizes it
	// against its local ExtensionContext (including ../ and ~ paths).
	toToolInput(input: string): string {
		const value = input.trim().replace(/^@/, "");
		if (process.platform === "win32" && path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
			if (value.startsWith("\\\\")) throw new Error(`UNC paths are not supported in SSH mode: ${input}`);
			if (isInside(this.encodedRoot, path.resolve(value)) !== undefined) {
				throw new Error("Encoded SSH paths are internal; use the original remote POSIX path instead.");
			}
			return path.win32.normalize(value); // Preserve already-encoded native absolute paths.
		}
		return this.toToolPath(this.resolveRemoteInput(value));
	}

	toRemotePath(toolPath: string): string {
		const absolute = path.resolve(toolPath);
		const encodedRelative = isInside(this.encodedRoot, absolute);
		if (encodedRelative !== undefined) {
			return path.posix.resolve("/", ...encodedRelative.split(path.sep).filter(Boolean).map(decodeURIComponent));
		}
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
		// Keep every remote path separate from local home/workspace aliases and
		// Windows /a drive syntax. Encoding also preserves POSIX ':' and '%' names.
		const normalized = path.posix.normalize(remotePath);
		return path.resolve(this.encodedRoot, ...normalized.split("/").filter(Boolean).map(encodeURIComponent));
	}
}
