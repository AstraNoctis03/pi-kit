import path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export type ResumeSort = "recent" | "threaded";
export type ArchiveView = "active" | "archived" | "all";
export interface ResumeState {
	sort: ResumeSort;
	archived: Set<string>;
}

type StateEvent = { version: 1; type: "sort"; sort: ResumeSort }
	| { version: 1; type: "archive"; key: string; archived: boolean };

export function sessionStateKey(info: Pick<SessionInfo, "path" | "id">): string {
	const file = path.resolve(info.path);
	return JSON.stringify([process.platform === "win32" ? file.toLowerCase() : file, info.id]);
}

export function matchesArchiveView(archived: boolean, view: ArchiveView): boolean {
	return view === "all" || (view === "archived" ? archived : !archived);
}

// A separate small append-only journal leaves transcripts/parent links untouched.
// Independent appends avoid read/modify/write updates losing another Pi process's changes.
export class ResumeStateStore {
	readonly file: string;
	constructor(file: string) { this.file = file; }

	async load(): Promise<ResumeState> {
		let text: string;
		try { text = await readFile(this.file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sort: "recent", archived: new Set() };
			throw error;
		}
		const state: ResumeState = { sort: "recent", archived: new Set() };
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			let event: unknown;
			try { event = JSON.parse(line); }
			catch { throw new Error(`Invalid resume state at ${this.file}:${index + 1}; refusing to reset archives.`); }
			if (!event || typeof event !== "object") throw new Error(`Invalid resume state at ${this.file}:${index + 1}`);
			const data = event as Record<string, unknown>;
			if (data.version === 1 && data.type === "sort" && (data.sort === "recent" || data.sort === "threaded")) {
				state.sort = data.sort;
			} else if (data.version === 1 && data.type === "archive" && typeof data.key === "string" && data.key
				&& typeof data.archived === "boolean") {
				if (data.archived) state.archived.add(data.key);
				else state.archived.delete(data.key);
			} else throw new Error(`Unsupported resume state at ${this.file}:${index + 1}; refusing to reset archives.`);
		}
		return state;
	}

	private async append(event: StateEvent): Promise<ResumeState> {
		await this.load(); // Never silently overwrite a corrupt or unsupported state file.
		await mkdir(path.dirname(this.file), { recursive: true });
		await appendFile(this.file, `\n${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		return this.load();
	}

	setSort(sort: ResumeSort): Promise<ResumeState> {
		return this.append({ version: 1, type: "sort", sort });
	}

	setArchived(info: Pick<SessionInfo, "path" | "id">, archived: boolean): Promise<ResumeState> {
		return this.append({ version: 1, type: "archive", key: sessionStateKey(info), archived });
	}
}
