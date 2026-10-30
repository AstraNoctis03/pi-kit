import path from "node:path";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { ENVIRONMENT_ENTRY, isSessionEnvironment, type SessionEnvironment } from "./environment.ts";

export interface EnvironmentSession {
	info: SessionInfo;
	environment?: SessionEnvironment;
}

interface Summary {
	id?: string;
	cwd?: string;
	parentSessionPath?: string;
	created?: number;
	modified?: number;
	name?: string;
	firstMessage: string;
	messageCount: number;
	environmentSeen: boolean;
	environment?: SessionEnvironment;
}

interface CachedSession {
	stats: Stats;
	offset: number;
	checkpoint: Buffer;
	summary: Summary;
	visibleSummary: Summary;
}

function consumeLine(line: Buffer, summary: Summary): void {
	let entry: Record<string, unknown>;
	try { entry = JSON.parse(line.toString("utf8")) as Record<string, unknown>; }
	catch { return; } // Ignore incomplete/corrupt JSONL entries, as the native picker does.
	if (!entry || typeof entry !== "object") return;
	if (entry.type === "session" && !summary.id) {
		summary.id = typeof entry.id === "string" ? entry.id : undefined;
		summary.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
		summary.parentSessionPath = typeof entry.parentSession === "string" ? entry.parentSession : undefined;
		summary.created = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined;
	} else if (entry.type === "session_info") {
		summary.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
	} else if (entry.type === "custom" && entry.customType === ENVIRONMENT_ENTRY && !summary.environmentSeen) {
		summary.environmentSeen = true;
		summary.environment = isSessionEnvironment(entry.data) ? entry.data : undefined;
	} else if (entry.type === "message") {
		summary.messageCount += 1;
		const message = entry.message as { timestamp?: unknown; role?: unknown; content?: unknown } | undefined;
		const time = typeof message?.timestamp === "number" ? message.timestamp
			: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		if (Number.isFinite(time)) summary.modified = Math.max(summary.modified ?? 0, time);
		if (!summary.firstMessage && message?.role === "user") {
			const content = message.content;
			const text = typeof content === "string" ? content : Array.isArray(content)
				? content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").join(" ") : "";
			// The picker searches summaries, not entire conversation bodies.
			summary.firstMessage = text.slice(0, 4096);
		}
	}
}

async function checkpoint(handle: FileHandle, offset: number): Promise<Buffer> {
	const buffer = Buffer.alloc(Math.min(256, offset));
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
	return buffer.subarray(0, bytesRead);
}

export class SessionIndex {
	private cache = new Map<string, CachedSession>();
	private readBytes = 0;
	get bytesRead(): number { return this.readBytes; }

	async read(file: string, signal?: AbortSignal): Promise<EnvironmentSession | undefined> {
		signal?.throwIfAborted();
		const handle = await open(file, "r");
		try {
			const stats = await handle.stat();
			signal?.throwIfAborted();
			const cached = this.cache.get(file);
			const sameFile = cached && cached.stats.ino === stats.ino && cached.stats.dev === stats.dev
				&& cached.stats.birthtimeMs === stats.birthtimeMs;
			let result = sameFile && cached.stats.size === stats.size && cached.stats.mtimeMs === stats.mtimeMs ? cached : undefined;
			if (!result) {
				// Session files are append-only. Verify the old tail before reusing a prefix.
				const append = sameFile && stats.size > cached.stats.size
					&& (await checkpoint(handle, cached.offset)).equals(cached.checkpoint);
				const summary: Summary = append ? { ...cached.summary }
					: { firstMessage: "", messageCount: 0, environmentSeen: false };
				let offset = append ? cached.offset : 0;
				let visibleSummary = summary;
				if (stats.size > offset) {
					const stream = handle.createReadStream({ start: offset, end: stats.size - 1, autoClose: false, signal });
					let parts: Buffer[] = [];
					let length = 0;
					for await (const chunk of stream) {
						this.readBytes += chunk.length;
						let start = 0;
						for (let end = chunk.indexOf(10, start); end >= 0; end = chunk.indexOf(10, start)) {
							const part: Buffer = chunk.subarray(start, end);
							parts.push(part);
							length += part.length;
							consumeLine(parts.length === 1 ? part : Buffer.concat(parts, length), summary);
							offset += length + 1;
							parts = [];
							length = 0;
							start = end + 1;
						}
						if (start < chunk.length) {
							parts.push(chunk.subarray(start));
							length += chunk.length - start;
						}
					}
					// Display a valid final JSON object even without a newline, but reread that
					// provisional line on append so a partially written entry is never lost/counts twice.
					if (parts.length) {
						visibleSummary = { ...summary };
						consumeLine(Buffer.concat(parts, length), visibleSummary);
					}
				}
				signal?.throwIfAborted();
				result = { stats, offset, checkpoint: await checkpoint(handle, offset), summary, visibleSummary };
				this.cache.set(file, result);
			}
			const summary = result.visibleSummary;
			if (!summary.id) return undefined;
			return {
				environment: summary.environment,
				info: {
					path: file, id: summary.id, cwd: summary.cwd ?? "", parentSessionPath: summary.parentSessionPath,
					name: summary.name, created: new Date(summary.created || stats.birthtimeMs),
					modified: new Date(summary.modified || summary.created || stats.mtimeMs),
					messageCount: summary.messageCount, firstMessage: summary.firstMessage || "(no messages)",
					allMessagesText: summary.firstMessage,
				},
			};
		} finally { await handle.close(); }
	}

	async list(root: string, grouped: boolean, publish: (rows: EnvironmentSession[], loaded: number, total: number) => void,
		signal: AbortSignal): Promise<EnvironmentSession[]> {
		let files: string[] = [];
		try {
			const entries = await readdir(root, { withFileTypes: true });
			if (grouped) {
				const directories = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
				for (const directory of directories) {
					signal.throwIfAborted();
					const dir = path.join(root, directory.name);
					try { files.push(...(await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name))); }
					catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
				}
			} else files = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")).map((entry) => path.join(root, entry.name));
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		signal.throwIfAborted();
		const discovered = await Promise.all(files.map(async (file) => {
			try { return { file, time: (await stat(file)).mtimeMs }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
		}));
		const candidates = discovered.filter((item): item is { file: string; time: number } => !!item);
		candidates.sort((a, b) => b.time - a.time);
		const rows: EnvironmentSession[] = [];
		let next = 0;
		let loaded = 0;
		const sorted = () => [...rows].sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
		publish([], 0, candidates.length);
		await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
			while (next < candidates.length) {
				signal.throwIfAborted();
				const file = candidates[next++].file;
				try {
					const row = await this.read(file, signal);
					if (row) rows.push(row);
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				loaded += 1;
				publish(sorted(), loaded, candidates.length);
			}
		}));
		return sorted();
	}
}
