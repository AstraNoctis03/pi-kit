import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const SSH_OPTIONS = [
	"-T",
	"-o", "BatchMode=yes",
	"-o", "ClearAllForwardings=yes",
	"-o", "ConnectTimeout=10",
	"-o", "LogLevel=ERROR",
];
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_SSH = 5;
// Shared by this extension runtime's clients, not by unrelated Pi processes.
const waitingSsh: Array<() => void> = [];
let activeSsh = 0;

function drainSshQueue(): void {
	while (activeSsh < MAX_CONCURRENT_SSH && waitingSsh.length > 0) waitingSsh.shift()?.();
}

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

			// One budget for queueing plus execution; do not restart it on admission.
			const timeoutMs = options.timeoutSeconds && options.timeoutSeconds > 0 ? options.timeoutSeconds * 1000 : undefined;
			const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let child: ChildProcessWithoutNullStreams | undefined;
			let started = false;
			let released = false;
			let timedOut = false;
			let settled = false;
			const timeoutError = () => new Error(`SSH operation timed out after ${options.timeoutSeconds}s`);
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
			const release = () => {
				if (released) return;
				released = true;
				activeSsh--;
				// Avoid recursive draining when a queued spawn throws synchronously.
				queueMicrotask(drainSshQueue);
			};
			const stop = (error: Error) => {
				if (settled) return;
				if (started) {
					child?.kill(); // Keep the slot until close, even after cancellation.
				} else {
					const index = waitingSsh.indexOf(start);
					if (index >= 0) waitingSsh.splice(index, 1);
					fail(error);
				}
			};
			const onAbort = () => stop(new Error("Operation aborted"));
			const start = () => {
				if (settled) return;
				if (options.signal?.aborted) { fail(new Error("Operation aborted")); return; }
				if (deadline !== undefined && performance.now() >= deadline) { fail(timeoutError()); return; }
				started = true;
				activeSsh++;
				let process: ChildProcessWithoutNullStreams;
				try {
					process = spawn("ssh", [...SSH_OPTIONS, this.target, command], {
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});
					child = process;
				} catch (error) {
					release();
					fail(new Error(`Failed to start SSH: ${error instanceof Error ? error.message : String(error)}`));
					return;
				}
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
				let outputBytes = 0;
				let overflow = false;
				const failRunning = (error: unknown) => {
					process.kill();
					fail(error instanceof Error ? error : new Error(String(error)));
				};
				const collect = (chunks: Buffer[], data: Buffer) => {
					if (settled) return;
					try { options.onData?.(data); } catch (error) { failRunning(error); return; }
					outputBytes += data.length;
					if (outputBytes > maxOutputBytes) {
						overflow = true;
						process.kill();
						return;
					}
					if (options.collectOutput !== false) chunks.push(data);
				};
				process.stdout.on("data", (data: Buffer) => collect(stdout, data));
				process.stderr.on("data", (data: Buffer) => collect(stderr, data));
				process.on("error", (error) => fail(new Error(`Failed to start SSH: ${error.message}`)));
				process.on("close", (code) => {
					release();
					if (settled) return;
					settled = true;
					cleanup();
					if (options.signal?.aborted) { reject(new Error("Operation aborted")); return; }
					if (timedOut) { reject(timeoutError()); return; }
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
				process.stdin.on("error", (error: NodeJS.ErrnoException) => {
					if (error.code !== "EPIPE") failRunning(error);
				});
				try {
					if (options.signal?.aborted || timedOut) process.kill();
					else process.stdin.end(options.input);
				} catch (error) { failRunning(error); }
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs !== undefined) timer = setTimeout(() => {
				timedOut = true;
				stop(timeoutError());
			}, timeoutMs);
			waitingSsh.push(start);
			drainSshQueue();
		});
	}
}
