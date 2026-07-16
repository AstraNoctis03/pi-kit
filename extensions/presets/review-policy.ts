export interface ReviewCommandDecision {
	allowed: boolean;
	reason?: string;
}

const SIMPLE_READ_COMMANDS = new Set([
	"cat", "df", "du", "fd", "file", "find", "grep", "head", "ls", "pwd", "rg", "stat", "tail", "tree", "type", "uname", "wc", "where", "which", "whoami",
]);
const GIT_READ_COMMANDS = new Set([
	"blame", "describe", "diff", "grep", "log", "ls-files", "rev-parse", "shortlog", "show", "status",
]);
const FORBIDDEN_FLAGS = new Set([
	"--fix", "--write", "--update", "--update-snapshots", "--updateSnapshot", "-u", "-w",
]);

function shellOperators(command: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (quote) {
			if (character === quote && command[index - 1] !== "\\") quote = undefined;
			if (quote === '"' && character === "$" && command[index + 1] === "(") return true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if ([";", "|", "&", ">", "<", "\n", "\r", "`"].includes(character)) return true;
		if (character === "$" && command[index + 1] === "(") return true;
	}
	return Boolean(quote);
}

function shellTokens(command: string): string[] {
	return (command.match(/(?:"(?:\\.|[^"])*"|'[^']*'|\S+)/g) ?? [])
		.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, ""));
}

function basename(command: string): string {
	return command.replace(/^.*[\\/]/, "").toLowerCase();
}

function hasForbiddenFlags(args: string[]): boolean {
	return args.some((arg) => FORBIDDEN_FLAGS.has(arg) || arg.startsWith("--fix=") || arg.startsWith("--write="));
}

function gitSubcommand(args: string[]): { name?: string; rest: string[]; index: number } {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (["-C", "--git-dir", "--work-tree"].includes(argument)) {
			index += 1;
			continue;
		}
		if (argument === "-c" || argument.startsWith("-c")) return { rest: [], index: -1 };
		if (argument.startsWith("-")) continue;
		return { name: argument.toLowerCase(), rest: args.slice(index + 1), index };
	}
	return { rest: [], index: -1 };
}

function isReadOnlyGit(args: string[]): boolean {
	const { name, rest, index } = gitSubcommand(args);
	if (!name) return false;
	const unsafeFlags = [
		"--paginate", "--config-env", "--exec-path",
		"--ext-diff", "--textconv", "--open-files-in-pager",
	];
	if (args.slice(0, index).includes("-p")) return false;
	if (args.some((arg) => unsafeFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) return false;
	if (rest.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
	if (GIT_READ_COMMANDS.has(name)) return true;
	if (name === "branch") {
		return rest.length === 0 || rest.every((arg) => ["--all", "--list", "--remotes", "--show-current", "-a", "-r", "-v", "-vv"].includes(arg));
	}
	if (name === "remote") {
		const operation = rest.find((arg) => !arg.startsWith("-"));
		return operation === undefined || operation === "get-url" || operation === "show";
	}
	if (name === "config") {
		const positional = rest.filter((arg) => !arg.startsWith("-"));
		const allowedFlags = new Set(["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope", "-l"]);
		return rest.filter((arg) => arg.startsWith("-")).every((arg) => allowedFlags.has(arg)) && positional.length <= 1;
	}
	return false;
}

function packageScriptArgs(command: string, args: string[]): string[] | undefined {
	const cwdFlags = command === "npm"
		? new Set(["--prefix"])
		: command === "pnpm"
			? new Set(["--dir", "-C"])
			: new Set(["--cwd"]);
	if (!args.length) return args;
	if (cwdFlags.has(args[0])) return args[1] && !args[1].startsWith("-") ? args.slice(2) : undefined;
	for (const flag of cwdFlags) {
		if (args[0].startsWith(`${flag}=`) && args[0].length > flag.length + 1) return args.slice(1);
	}
	return args;
}

function isAllowedPackageScript(command: string, args: string[]): boolean {
	if (!args.length || hasForbiddenFlags(args)) return false;
	const scriptArgs = packageScriptArgs(command, args);
	if (!scriptArgs?.length) return false;
	if (command === "npm") {
		if (scriptArgs[0] === "test") return true;
		if (scriptArgs[0] !== "run" || !scriptArgs[1]) return false;
		return /^(?:test|lint|typecheck|check|validate)(?::[a-z0-9_-]+)?$/i.test(scriptArgs[1]);
	}
	if (["pnpm", "yarn", "bun"].includes(command)) {
		const script = scriptArgs[0] === "run" ? scriptArgs[1] : scriptArgs[0];
		return Boolean(script && /^(?:test|lint|typecheck|check|validate)(?::[a-z0-9_-]+)?$/i.test(script));
	}
	return false;
}

function isAllowedVerifier(command: string, args: string[]): boolean {
	if (hasForbiddenFlags(args)) return false;
	if (["pytest", "mypy", "pyright", "shellcheck"].includes(command)) return true;
	if (command === "python" || command === "python3") return args[0] === "-m" && ["pytest", "unittest", "mypy"].includes(args[1] ?? "");
	if (command === "node") return args.includes("--test");
	if (command === "tsc") return args.includes("--noEmit") || args.includes("--no-emit");
	if (command === "eslint") {
		return !args.some((arg) =>
			["-o", "--output-file", "--cache", "--cache-location"].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
	}
	if (command === "prettier") return args.includes("--check");
	if (command === "biome") return ["check", "lint"].includes(args[0] ?? "");
	if (command === "ruff") return args[0] === "check";
	if (command === "cargo") return ["check", "clippy", "test"].includes(args[0] ?? "");
	if (command === "go") return ["test", "vet"].includes(args[0] ?? "");
	if (command === "deno") return ["check", "lint", "test"].includes(args[0] ?? "");
	if (command === "dotnet") return args[0] === "test";
	if (["mvn", "mvnw", "gradle", "gradlew"].includes(command)) return args.some((arg) => /^(?:check|test)$/.test(arg));
	if (command === "make") return args.length === 1 && /^(?:check|lint|test|typecheck|validate)$/.test(args[0]);
	return false;
}

function isSafeReadCommand(command: string, args: string[]): boolean {
	if (!SIMPLE_READ_COMMANDS.has(command)) return false;
	if (command === "find" && args.some((arg) => [
		"-delete", "-exec", "-execdir", "-fls", "-fprint", "-fprint0", "-fprintf", "-ok", "-okdir",
	].includes(arg))) return false;
	if (command === "fd" && args.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg) || arg.startsWith("--exec="))) return false;
	if (command === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
	if (command === "tree" && args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="))) return false;
	return true;
}

export function reviewCommandDecision(command: string): ReviewCommandDecision {
	const trimmed = command.trim();
	if (!trimmed) return { allowed: false, reason: "Empty commands are not useful in review mode." };
	if (shellOperators(trimmed)) {
		return { allowed: false, reason: "Shell operators, redirections, chaining, and command substitution are blocked in review mode." };
	}
	const tokens = shellTokens(trimmed);
	const name = basename(tokens[0] ?? "");
	const args = tokens.slice(1);
	if (!name || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) {
		return { allowed: false, reason: "Environment assignments and unknown commands are blocked in review mode." };
	}
	if (name === "git" && isReadOnlyGit(args)) return { allowed: true };
	if (isSafeReadCommand(name, args)) return { allowed: true };
	if (isAllowedPackageScript(name, args)) return { allowed: true };
	if (isAllowedVerifier(name, args)) return { allowed: true };
	return { allowed: false, reason: `Command is not on the review-mode allowlist: ${name}` };
}
