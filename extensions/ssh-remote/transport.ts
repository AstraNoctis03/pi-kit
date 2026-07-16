import { spawn } from "node:child_process";

const SSH_OPTIONS = [
	"-T",
	"-o", "BatchMode=yes",
	"-o", "ClearAllForwardings=yes",
	"-o", "ConnectTimeout=10",
	"-o", "LogLevel=ERROR",
];
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface SshRunOptions {
	allowedExitCodes?: readonly number[] | "any";
	collectOutput?: boolean;
	input?: Buffer | string;
	maxOutputBytes?: number;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
}

export interface SshRunResult {
	exitCode: number | null;
	stderr: Buffer;
	stdout: Buffer;
}

export function quoteShell(value: string): string {
	if (value.includes("\0")) throw new Error("Shell argument contains a NUL byte.");
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class SshClient {
	readonly target: string;

	constructor(target: string) {
		this.target = target;
	}

	run(command: string, options: SshRunOptions = {}): Promise<SshRunResult> {
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			const child = spawn("ssh", [...SSH_OPTIONS, this.target, command], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
			let outputBytes = 0;
			let timedOut = false;
			let overflow = false;
			let settled = false;

			const timer = options.timeoutSeconds && options.timeoutSeconds > 0
				? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeoutSeconds * 1000)
				: undefined;
			const onAbort = () => child.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const collect = (chunks: Buffer[], data: Buffer) => {
				options.onData?.(data);
				outputBytes += data.length;
				if (outputBytes > maxOutputBytes) {
					overflow = true;
					child.kill();
					return;
				}
				if (options.collectOutput !== false) chunks.push(data);
			};

			child.stdout.on("data", (data: Buffer) => collect(stdout, data));
			child.stderr.on("data", (data: Buffer) => collect(stderr, data));
			child.on("error", (error) => fail(new Error(`Failed to start SSH: ${error.message}`)));
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (options.signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`SSH operation timed out after ${options.timeoutSeconds}s`));
					return;
				}
				if (overflow) {
					reject(new Error(`SSH output exceeded ${Math.floor(maxOutputBytes / 1024 / 1024)}MB; narrow the operation.`));
					return;
				}

				const result = { exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
				const allowed = options.allowedExitCodes ?? [0];
				if (allowed !== "any" && (code === null || !allowed.includes(code))) {
					const detail = result.stderr.toString("utf8").trim() || `exit code ${code ?? "null"}`;
					reject(new Error(`SSH ${this.target}: ${detail}`));
					return;
				}
				resolve(result);
			});

			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") fail(error);
			});
			child.stdin.end(options.input);
		});
	}
}
