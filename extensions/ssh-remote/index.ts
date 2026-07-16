import path from "node:path";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
	type BashOperations,
	type EditOperations,
	type ExtensionAPI,
	type FindToolDetails,
	type GrepToolDetails,
	type LsToolDetails,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { findPathPatterns, parseSshTarget } from "./config.ts";
import { RemotePathMapper, syntheticRemoteCwd } from "./paths.ts";
import { quoteShell, SshClient } from "./transport.ts";

const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_LS_LIMIT = 500;

interface RemoteSession {
	client: SshClient;
	hasRipgrep: boolean;
	host: string;
	localCwd: string;
	mapper: RemotePathMapper;
	remoteCwd: string;
	remoteHome: string;
}

interface TextResult<T> {
	content: Array<{ type: "text"; text: string }>;
	details: T | undefined;
}

function createReadOperations(getSession: () => RemoteSession): ReadOperations {
	return {
		readFile: async (filePath) => {
			const { client, mapper } = getSession();
			return (await client.run(`cat -- ${quoteShell(mapper.toRemotePath(filePath))}`)).stdout;
		},
		access: async (filePath) => {
			const { client, mapper } = getSession();
			await client.run(`test -r ${quoteShell(mapper.toRemotePath(filePath))}`);
		},
		detectImageMimeType: async (filePath) => {
			try {
				const { client, mapper } = getSession();
				const result = await client.run(`file --mime-type -b -- ${quoteShell(mapper.toRemotePath(filePath))}`);
				const mime = result.stdout.toString("utf8").trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createWriteOperations(getSession: () => RemoteSession): WriteOperations {
	return {
		mkdir: async (dirPath) => {
			const { client, mapper } = getSession();
			await client.run(`mkdir -p -- ${quoteShell(mapper.toRemotePath(dirPath))}`);
		},
		writeFile: async (filePath, content) => {
			const { client, mapper } = getSession();
			await client.run(`cat > ${quoteShell(mapper.toRemotePath(filePath))}`, { input: content });
		},
	};
}

function createEditOperations(getSession: () => RemoteSession): EditOperations {
	const read = createReadOperations(getSession);
	const write = createWriteOperations(getSession);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (filePath) => {
			const session = getSession();
			const remotePath = session.mapper.toRemotePath(filePath);
			await session.client.run(`test -r ${quoteShell(remotePath)} && test -w ${quoteShell(remotePath)}`);
		},
	};
}

function createBashOperations(getSession: () => RemoteSession): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const session = getSession();
			const remoteCwd = session.mapper.toRemotePath(cwd);
			const result = await session.client.run(`cd ${quoteShell(remoteCwd)} && ${command}`, {
				allowedExitCodes: "any",
				collectOutput: false,
				maxOutputBytes: Number.MAX_SAFE_INTEGER,
				onData,
				signal,
				timeoutSeconds: timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}

function relativeRemotePath(root: string, filePath: string): string {
	const relative = path.posix.relative(root, filePath);
	return relative && !relative.startsWith("../") ? relative : path.posix.basename(filePath);
}

async function executeRemoteLs(
	session: RemoteSession,
	inputPath: string | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<TextResult<LsToolDetails>> {
	const remotePath = session.mapper.resolveRemoteInput(inputPath ?? ".");
	const effectiveLimit = Math.max(1, Math.min(limit ?? DEFAULT_LS_LIMIT, 10_000));
	const listPipeline = `find ${quoteShell(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n' `
		+ `| head -n ${effectiveLimit + 1}; statuses=("\${PIPESTATUS[@]}"); `
		+ `if [ "\${statuses[0]}" -ne 0 ] && [ "\${statuses[0]}" -ne 141 ]; then exit "\${statuses[0]}"; fi; `
		+ `if [ "\${statuses[1]}" -ne 0 ]; then exit "\${statuses[1]}"; fi; exit 0`;
	const command = [
		`test -e ${quoteShell(remotePath)} || { printf 'Path not found: %s\\n' ${quoteShell(remotePath)} >&2; exit 44; }`,
		`test -d ${quoteShell(remotePath)} || { printf 'Not a directory: %s\\n' ${quoteShell(remotePath)} >&2; exit 45; }`,
		`bash -c ${quoteShell(listPipeline)}`,
	].join(" && ");
	const result = await session.client.run(command, { signal });
	const entries: string[] = [];
	for (const line of result.stdout.toString("utf8").split("\n")) {
		const separator = line.lastIndexOf("\t");
		if (separator < 0) continue;
		const name = line.slice(0, separator);
		const type = line.slice(separator + 1);
		if (name) entries.push(type === "d" ? `${name}/` : name);
	}
	entries.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
	if (entries.length === 0) return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };

	const limited = entries.slice(0, effectiveLimit);
	const truncation = truncateHead(limited.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: LsToolDetails = {};
	const notices: string[] = [];
	if (entries.length > effectiveLimit) {
		details.entryLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} entries limit reached`);
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

async function executeRemoteFind(
	session: RemoteSession,
	pattern: string,
	inputPath: string | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<TextResult<FindToolDetails>> {
	const root = session.mapper.resolveRemoteInput(inputPath ?? ".");
	const effectiveLimit = Math.max(1, Math.min(limit ?? DEFAULT_FIND_LIMIT, 10_000));
	const patterns = findPathPatterns(root, pattern);
	const predicate = patterns.length === 1 && !patterns[0].includes("/")
		? `-name ${quoteShell(patterns[0])}`
		: `\\( ${patterns.map((item) => `-path ${quoteShell(item)}`).join(" -o ")} \\)`;
	const findPipeline = `find ${quoteShell(root)} -mindepth 1 \\( -name .git -o -name node_modules \\) -prune -o `
		+ `-type f ${predicate} -print 2>/dev/null | head -n ${effectiveLimit + 1}; statuses=("\${PIPESTATUS[@]}"); `
		+ `if [ "\${statuses[0]}" -ne 0 ] && [ "\${statuses[0]}" -ne 1 ] && [ "\${statuses[0]}" -ne 141 ]; then exit "\${statuses[0]}"; fi; `
		+ `if [ "\${statuses[1]}" -ne 0 ]; then exit "\${statuses[1]}"; fi; exit 0`;
	const command = `test -e ${quoteShell(root)} || { printf 'Path not found: %s\\n' ${quoteShell(root)} >&2; exit 44; }; `
		+ `bash -c ${quoteShell(findPipeline)}`;
	const result = await session.client.run(command, { signal });
	const matches = result.stdout.toString("utf8").split("\n").filter(Boolean);
	if (matches.length === 0) {
		return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
	}

	const limited = matches.slice(0, effectiveLimit).map((item) => relativeRemotePath(root, item));
	const truncation = truncateHead(limited.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (matches.length > effectiveLimit) {
		details.resultLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} results limit reached`);
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

function eventText(event: Record<string, unknown>): { filePath: string; line: number; text: string } | undefined {
	const data = event.data as { path?: { text?: string }; line_number?: number; lines?: { text?: string } } | undefined;
	if (!data?.path?.text || typeof data.line_number !== "number" || typeof data.lines?.text !== "string") return undefined;
	return { filePath: data.path.text, line: data.line_number, text: data.lines.text.replace(/\r?\n$/, "") };
}

async function executeRemoteGrepFallback(
	session: RemoteSession,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<TextResult<GrepToolDetails>> {
	const root = session.mapper.resolveRemoteInput(params.path ?? ".");
	const effectiveLimit = Math.max(1, Math.min(params.limit ?? DEFAULT_GREP_LIMIT, 10_000));
	const args = ["-R", "-n", "-H", "-I", "--color=never", "--exclude-dir=.git", "--exclude-dir=node_modules"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	else args.push("--extended-regexp");
	if (params.glob) args.push(`--include=${params.glob}`);
	if (params.context && params.context > 0) args.push("--context", String(params.context));
	args.push("--", params.pattern, root);
	const limiter = `awk -v limit=${effectiveLimit} 'BEGIN { matches = 0 } `
		+ `{ if ($0 ~ /:[0-9]+:/) { matches++; if (matches > limit) { print "__PI_SSH_MATCH_LIMIT__"; exit } } print }'`;
	const grepPipeline = `grep ${args.map(quoteShell).join(" ")} | ${limiter}; `
		+ `grep_status=\${PIPESTATUS[0]}; `
		+ `if [ "$grep_status" -ne 0 ] && [ "$grep_status" -ne 1 ] && [ "$grep_status" -ne 141 ]; then exit "$grep_status"; fi; exit 0`;
	const result = await session.client.run(`bash -c ${quoteShell(grepPipeline)}`, { signal });
	const outputLines: string[] = [];
	let matchLimitReached = false;
	let linesTruncated = false;
	const directoryPrefix = `${root.replace(/\/$/, "")}/`;

	for (const rawLine of result.stdout.toString("utf8").split("\n")) {
		if (!rawLine) continue;
		if (rawLine === "__PI_SSH_MATCH_LIMIT__") {
			matchLimitReached = true;
			continue;
		}
		let line = rawLine;
		if (line.startsWith(directoryPrefix)) line = line.slice(directoryPrefix.length);
		else if (line.startsWith(`${root}:`) || line.startsWith(`${root}-`)) line = `${path.posix.basename(root)}${line.slice(root.length)}`;
		const truncated = truncateLine(line);
		if (truncated.wasTruncated) linesTruncated = true;
		outputLines.push(truncated.text);
	}
	if (outputLines.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

async function executeRemoteGrep(
	session: RemoteSession,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<TextResult<GrepToolDetails>> {
	if (!session.hasRipgrep) return executeRemoteGrepFallback(session, params, signal);
	const root = session.mapper.resolveRemoteInput(params.path ?? ".");
	const effectiveLimit = Math.max(1, Math.min(params.limit ?? DEFAULT_GREP_LIMIT, 10_000));
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	if (params.context && params.context > 0) args.push("--context", String(params.context));
	args.push("--", params.pattern, root);
	const limiter = `awk -v limit=${effectiveLimit} 'BEGIN { matches = 0 } `
		+ `{ print; if ($0 ~ /^\\{\"type\":\"match\"/) { matches++; if (matches > limit) exit } }'`;
	const grepPipeline = `rg ${args.map(quoteShell).join(" ")} | ${limiter}; `
		+ `rg_status=\${PIPESTATUS[0]}; `
		+ `if [ "$rg_status" -ne 0 ] && [ "$rg_status" -ne 1 ] && [ "$rg_status" -ne 141 ]; then exit "$rg_status"; fi; exit 0`;
	const command = `command -v rg >/dev/null 2>&1 || { printf 'ripgrep (rg) is required on the remote server\\n' >&2; exit 127; }; `
		+ `bash -c ${quoteShell(grepPipeline)}`;
	const result = await session.client.run(command, { signal });
	const outputLines: string[] = [];
	let matchCount = 0;
	let linesTruncated = false;

	for (const line of result.stdout.toString("utf8").split("\n")) {
		if (!line) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = event.type;
		if (type === "match") matchCount += 1;
		if (type !== "match" && type !== "context") continue;
		if (matchCount > effectiveLimit) continue;
		const parsed = eventText(event);
		if (!parsed) continue;
		const displayPath = relativeRemotePath(root, parsed.filePath);
		const separator = type === "match" ? ":" : "-";
		const truncated = truncateLine(parsed.text);
		if (truncated.wasTruncated) linesTruncated = true;
		outputLines.push(`${displayPath}${separator}${parsed.line}${separator} ${truncated.text}`);
	}
	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchCount > effectiveLimit) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

function registerRemoteTools(pi: ExtensionAPI, getSession: () => RemoteSession, toolCwd: string): void {
	const read = createReadTool(toolCwd, { operations: createReadOperations(getSession) });
	const write = createWriteTool(toolCwd, { operations: createWriteOperations(getSession) });
	const edit = createEditTool(toolCwd, { operations: createEditOperations(getSession) });
	const bash = createBashTool(toolCwd, { operations: createBashOperations(getSession) });
	const ls = createLsTool(toolCwd);
	const find = createFindTool(toolCwd);
	const grep = createGrepTool(toolCwd);

	pi.registerTool(read);
	pi.registerTool(write);
	pi.registerTool(edit);
	pi.registerTool(bash);
	pi.registerTool({
		...ls,
		execute: (_id, params, signal) => executeRemoteLs(getSession(), params.path, params.limit, signal),
	});
	pi.registerTool({
		...find,
		description: "Search remote files by glob pattern. Excludes .git and node_modules; other .gitignore rules are not applied.",
		promptSnippet: "Find files on the SSH server by glob pattern",
		execute: (_id, params, signal) => executeRemoteFind(getSession(), params.pattern, params.path, params.limit, signal),
	});
	pi.registerTool({
		...grep,
		description: "Search remote file contents. Uses ripgrep when available, otherwise GNU grep; the fallback excludes .git and node_modules but does not apply other .gitignore rules.",
		promptSnippet: "Search file contents on the SSH server",
		execute: (_id, params, signal) => executeRemoteGrep(getSession(), params, signal),
	});
}

export default function sshRemote(pi: ExtensionAPI): void {
	pi.registerFlag("ssh", {
		description: "Route tools through SSH: alias or alias:/absolute/remote/path",
		type: "string",
	});

	let requested = false;
	let registered = false;
	let session: RemoteSession | undefined;
	let startupError: string | undefined;
	const requireSession = () => {
		if (session) return session;
		throw new Error(startupError ? `SSH mode unavailable: ${startupError}` : "SSH mode is not initialized.");
	};

	pi.on("session_start", async (_event, ctx) => {
		const rawTarget = pi.getFlag("ssh") as string | undefined;
		if (!rawTarget) return;
		requested = true;
		if (!registered) {
			registerRemoteTools(pi, requireSession, syntheticRemoteCwd(ctx.cwd));
			registered = true;
		}
		let displayHost = rawTarget;
		try {
			const parsed = parseSshTarget(rawTarget);
			displayHost = parsed.host;
			const client = new SshClient(parsed.host);
			const changeDirectory = parsed.remoteCwd ? `cd ${quoteShell(parsed.remoteCwd)} && ` : "";
			const probeCommand = `${changeDirectory}test -r . || exit $?; printf '%s\\0%s\\0' "$PWD" "$HOME"; `
				+ `if command -v rg >/dev/null 2>&1; then printf '1\\0'; else printf '0\\0'; fi`;
			const probe = await client.run(probeCommand, { timeoutSeconds: 15 });
			const [remoteCwd, remoteHome, ripgrepFlag] = probe.stdout.toString("utf8").split("\0");
			if (!remoteCwd || !remoteHome) throw new Error("Remote shell did not report PWD and HOME.");
			session = {
				client,
				hasRipgrep: ripgrepFlag === "1",
				host: parsed.host,
				localCwd: ctx.cwd,
				remoteCwd,
				remoteHome,
				mapper: new RemotePathMapper(ctx.cwd, remoteCwd, remoteHome),
			};
			ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("accent", `SSH: ${parsed.host}:${remoteCwd}`));
			ctx.ui.notify(`SSH remote mode: ${parsed.host}:${remoteCwd}`, "info");
		} catch (error) {
			startupError = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("error", `SSH failed: ${displayHost}`));
			ctx.ui.notify(`SSH remote mode failed: ${startupError}`, "error");
			throw error;
		}
	});

	pi.on("user_bash", async () => {
		if (!requested) return undefined;
		if (!session) {
			return {
				result: {
					output: `${startupError ?? "SSH mode is not initialized."}\n`,
					exitCode: 255,
					cancelled: false,
					truncated: false,
				},
			};
		}
		return { operations: createBashOperations(requireSession) };
	});

	pi.on("before_agent_start", async (event) => {
		if (!requested) return undefined;
		if (!session) {
			return { systemPrompt: `${event.systemPrompt}\n\nSSH remote mode is unavailable. Do not use file or shell tools.` };
		}
		const localLine = `Current working directory: ${session.localCwd}`;
		const remoteLine = `Current working directory: ${session.remoteCwd} (via SSH: ${session.host}). All file and shell tools operate on this remote server.`;
		return {
			systemPrompt: event.systemPrompt.includes(localLine)
				? event.systemPrompt.replace(localLine, remoteLine)
				: `${event.systemPrompt}\n\n${remoteLine}`,
		};
	});

	pi.registerCommand("ssh-status", {
		description: "Show SSH remote mode status",
		handler: async (_args, ctx) => {
			if (session) {
				const searchBackend = session.hasRipgrep ? "ripgrep" : "GNU grep fallback";
				ctx.ui.notify(`SSH target: ${session.host}\nRemote cwd: ${session.remoteCwd}\nRemote home: ${session.remoteHome}\nSearch: ${searchBackend}`, "info");
			} else if (startupError) {
				ctx.ui.notify(`SSH remote mode failed: ${startupError}`, "error");
			} else {
				ctx.ui.notify("SSH remote mode is disabled. Start pi with --ssh alias:/remote/path.", "info");
			}
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("ssh-remote", undefined);
	});
}
