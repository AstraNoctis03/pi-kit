export type GuardAction = "block" | "confirm";

export interface GuardDecision {
	action: GuardAction;
	reason: string;
	ruleName: string;
}

const READ_ONLY_GIT_COMMANDS = new Set([
	"blame", "describe", "diff", "grep", "log", "ls-files", "rev-parse", "shortlog", "show", "status",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MUTATIONS = new Set([
	"add", "ci", "create", "dlx", "exec", "i", "install", "remove", "rm", "un", "uninstall", "update", "upgrade",
]);
const SYSTEM_COMMANDS = new Set(["chown", "reboot", "service", "shutdown", "systemctl"]);
const WINDOWS_MOUNT_PATTERN = /(?:^|[\s"'=])\/mnt\/[cd](?:\/|$)/i;
const WINDOWS_DRIVE_PATTERN = /(?:^|[\s"'=])[cd]:[\\/]/i;
const WINDOWS_WRITE_COMMANDS = new Set([
	"chmod", "chown", "cp", "dd", "install", "mkdir", "mv", "rename", "rm", "rmdir", "rsync", "tee", "touch", "truncate",
]);

export function findCommandDecision(command: string, platform = process.platform): GuardDecision | undefined {
	const segments = splitCommandSegments(command);
	let protectedCwd = false;

	for (const segment of segments) {
		const parsed = parseCommand(segment);
		if (!parsed) continue;

		if (parsed.name === "cd") {
			protectedCwd = isProtectedWindowsPath(parsed.args.at(-1) ?? "", platform);
			continue;
		}

		const effective = unwrapCommand(parsed);
		const destructiveDelete = findDestructiveDelete(effective);
		if (destructiveDelete) return destructiveDelete;

		if (writesProtectedWindowsPath(segment, effective, platform, protectedCwd)) {
			return decision("block", "windows-path-write", "Writing to Windows-mounted paths from WSL/Linux is blocked.");
		}

		const confirmation = findConfirmation(parsed) ?? (effective === parsed ? undefined : findConfirmation(effective));
		if (confirmation) return confirmation;
	}

	return undefined;
}

export function findToolPathDecision(path: string, platform = process.platform): GuardDecision | undefined {
	if (!isProtectedWindowsPath(normalizePath(path), platform)) return undefined;
	return decision("block", "windows-tool-write", `Writing to a Windows-mounted path from WSL/Linux is blocked: ${path}`);
}

function findDestructiveDelete({ name, args }: ParsedCommand): GuardDecision | undefined {
	if (name !== "rm") return undefined;

	const recursive = args.some((arg) => arg === "--recursive" || /^-[a-z]*r[a-z]*$/i.test(arg));
	const force = args.some((arg) => arg === "--force" || /^-[a-z]*f[a-z]*$/i.test(arg));
	if (!recursive || !force) return undefined;

	for (const target of positionalArgs(args)) {
		if (target === "/" || target === "/*") {
			return decision("block", "rm-root", "Recursive deletion of the root directory is blocked.");
		}
		if (isHomeTarget(target)) {
			return decision("block", "rm-home", "Recursive deletion of the home directory is blocked.");
		}
	}
	return undefined;
}

function findConfirmation(parsed: ParsedCommand): GuardDecision | undefined {
	if (parsed.name === "sudo") {
		return decision("confirm", "sudo", "This command requests administrator privileges.");
	}
	if (parsed.name === "rm" || parsed.name === "rmdir") {
		return decision("confirm", "delete", "This command deletes files or directories.");
	}
	if (parsed.name === "chmod" && parsed.args.some((arg) => arg === "--recursive" || /^-[a-z]*r/i.test(arg))) {
		return decision("confirm", "chmod-recursive", "This command recursively changes permissions.");
	}
	if (parsed.name === "systemctl" && isReadOnlySystemctl(parsed.args)) return undefined;
	if (parsed.name === "service" && isReadOnlyService(parsed.args)) return undefined;
	if (SYSTEM_COMMANDS.has(parsed.name) || parsed.name === "mkfs" || parsed.name.startsWith("mkfs.")) {
		return decision("confirm", `system-${parsed.name}`, "This command may modify system-level resources.");
	}
	if (parsed.name === "dd" && parsed.args.some((arg) => arg.startsWith("of="))) {
		return decision("confirm", "dd-output", "This command writes directly to a file or device.");
	}
	if (parsed.name === "git" && !isReadOnlyGitCommand(parsed.args)) {
		const subcommand = gitCommand(parsed.args).name ?? "unknown";
		return decision("confirm", `git-${subcommand}`, "This Git command may modify the worktree, history, or a remote.");
	}
	if (PACKAGE_MANAGERS.has(parsed.name)) {
		const subcommand = firstSubcommand(parsed.args);
		if (subcommand && PACKAGE_MUTATIONS.has(subcommand)) {
			return decision("confirm", `package-${parsed.name}-${subcommand}`, "This command may install, remove, or update dependencies.");
		}
	}
	if (parsed.name === "npx") {
		return decision("confirm", "package-npx", "This command may download and execute a package.");
	}
	if (["bash", "sh", "zsh", "pwsh", "powershell"].includes(parsed.name) && parsed.args.some((arg) => ["-c", "-Command"].includes(arg))) {
		return decision("confirm", "nested-shell", "This command executes a nested shell expression that cannot be inspected reliably.");
	}
	if (["pip", "pip3", "uv", "conda", "mamba", "apt", "apt-get", "brew"].includes(parsed.name)) {
		const subcommand = firstSubcommand(parsed.args);
		if (subcommand && ["add", "create", "install", "pip", "purge", "remove", "sync", "uninstall", "update", "upgrade"].includes(subcommand)) {
			return decision("confirm", `package-${parsed.name}-${subcommand}`, "This command may modify environments or dependencies.");
		}
	}
	return undefined;
}

function writesProtectedWindowsPath(segment: string, parsed: ParsedCommand, platform: string, protectedCwd: boolean): boolean {
	if (platform === "win32") return false;
	if (protectedCwd && isWriteLikeCommand(parsed)) return true;

	const redirection = segment.match(/(?:>|>>)\s*([^\s;&|]+)/g) ?? [];
	if (redirection.some((item) => isProtectedWindowsPath(item.replace(/^(?:>|>>)\s*/, ""), platform))) return true;

	if (!containsProtectedWindowsPath(segment, platform)) return false;
	if (["cp", "install", "rsync"].includes(parsed.name)) {
		return isProtectedWindowsPath(positionalArgs(parsed.args).at(-1) ?? "", platform);
	}
	if (parsed.name === "dd") {
		return parsed.args.some((arg) => arg.startsWith("of=") && isProtectedWindowsPath(arg.slice(3), platform));
	}
	return WINDOWS_WRITE_COMMANDS.has(parsed.name) || (parsed.name === "sed" && parsed.args.some((arg) => /^-[a-z]*i/i.test(arg)));
}

function isWriteLikeCommand(parsed: ParsedCommand): boolean {
	if (WINDOWS_WRITE_COMMANDS.has(parsed.name)) return true;
	if (parsed.name === "git") return !isReadOnlyGitCommand(parsed.args);
	if (PACKAGE_MANAGERS.has(parsed.name)) return PACKAGE_MUTATIONS.has(firstSubcommand(parsed.args) ?? "");
	return parsed.name === "sed" && parsed.args.some((arg) => /^-[a-z]*i/i.test(arg));
}

function containsProtectedWindowsPath(value: string, platform: string): boolean {
	return platform !== "win32" && (WINDOWS_MOUNT_PATTERN.test(value) || WINDOWS_DRIVE_PATTERN.test(value));
}

function isProtectedWindowsPath(path: string, platform: string): boolean {
	if (platform === "win32") return false;
	const normalized = normalizePath(path);
	return /^\/mnt\/[cd](?:\/|$)/i.test(normalized) || /^[cd]:[\\/]/i.test(normalized);
}

function normalizePath(path: string): string {
	return path.trim().replace(/^@/, "").replace(/^["']|["']$/g, "");
}

interface ParsedCommand {
	name: string;
	args: string[];
}

function parseCommand(segment: string): ParsedCommand | undefined {
	const tokens = shellTokens(segment);
	if (tokens.length === 0) return undefined;
	let index = 0;
	while (["then", "do", "else", "!", "{"].includes(tokens[index] ?? "")) index += 1;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
	if (["command", "time"].includes(tokens[index] ?? "")) index += 1;
	const name = basename(tokens[index] ?? "").toLowerCase();
	return name ? { name, args: tokens.slice(index + 1) } : undefined;
}

function unwrapCommand(parsed: ParsedCommand): ParsedCommand {
	let current = parsed;
	if (current.name === "sudo") {
		const optionsWithValue = new Set(["-C", "-g", "-h", "-p", "-T", "-u", "--chdir", "--close-from", "--command-timeout", "--group", "--host", "--prompt", "--user"]);
		let index = 0;
		while (index < current.args.length) {
			const arg = current.args[index];
			if (arg === "--") {
				index += 1;
				break;
			}
			if (!arg.startsWith("-")) break;
			index += optionsWithValue.has(arg) ? 2 : 1;
		}
		const name = basename(current.args[index] ?? "").toLowerCase();
		if (name) current = { name, args: current.args.slice(index + 1) };
	}
	if (current.name === "env") {
		let index = 0;
		while (index < current.args.length) {
			const arg = current.args[index];
			if (arg === "-u" || arg === "--unset") {
				index += 2;
				continue;
			}
			if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
				index += 1;
				continue;
			}
			break;
		}
		const name = basename(current.args[index] ?? "").toLowerCase();
		if (name) current = { name, args: current.args.slice(index + 1) };
	}
	return current;
}

function gitCommand(args: string[]): { name?: string; rest: string[] } {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (["-C", "-c", "--git-dir", "--work-tree"].includes(arg)) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return { name: arg.toLowerCase(), rest: args.slice(index + 1) };
	}
	return { rest: [] };
}

function isReadOnlyGitCommand(args: string[]): boolean {
	const { name, rest } = gitCommand(args);
	if (!name || name === "help" || name === "version" || READ_ONLY_GIT_COMMANDS.has(name)) return true;
	if (name === "branch") {
		const mutation = /^(?:-[a-z]*[dDmMcC]|--(?:copy|delete|edit-description|move))$/;
		return !rest.some((arg) => mutation.test(arg)) && !rest.some((arg) => !arg.startsWith("-"));
	}
	if (name === "remote") {
		const operation = rest.find((arg) => !arg.startsWith("-"));
		return operation === undefined || operation === "get-url" || operation === "show";
	}
	if (name === "config") {
		const mutationFlags = new Set(["--add", "--edit", "--remove-section", "--rename-section", "--replace-all", "--unset", "--unset-all"]);
		if (rest.some((arg) => mutationFlags.has(arg))) return false;
		return rest.filter((arg) => !arg.startsWith("-")).length <= 1;
	}
	return false;
}

function isReadOnlySystemctl(args: string[]): boolean {
	const command = firstSubcommand(args);
	return !command || ["cat", "get-default", "is-active", "is-enabled", "list-unit-files", "list-units", "show", "status"].includes(command);
}

function isReadOnlyService(args: string[]): boolean {
	if (args.includes("--status-all")) return true;
	const positional = args.filter((arg) => !arg.startsWith("-"));
	return positional.length === 2 && positional[1] === "status";
}

function firstSubcommand(args: string[]): string | undefined {
	return args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
}

function positionalArgs(args: string[]): string[] {
	return args.filter((arg) => arg !== "--" && !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
}

function isHomeTarget(target: string): boolean {
	return target === "~" || target.startsWith("~/") || target === "$HOME" || target.startsWith("$HOME/") || target === "${HOME}" || target.startsWith("${HOME}/");
}

function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		const next = command[index + 1];
		if (quote) {
			current += char;
			if (char === quote && command[index - 1] !== "\\") quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\n" || char === ";" || char === "|" || (char === "&" && next === "&")) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if ((char === "|" && next === "|") || (char === "&" && next === "&")) index += 1;
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function shellTokens(segment: string): string[] {
	return (segment.match(/(?:"(?:\\.|[^"])*"|'[^']*'|\S+)/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""));
}

function basename(command: string): string {
	return command.replace(/^.*[\\/]/, "");
}

function decision(action: GuardAction, ruleName: string, reason: string): GuardDecision {
	return { action, ruleName, reason };
}
