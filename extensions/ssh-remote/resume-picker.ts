import { SessionSelectorComponent, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { environmentDescription, matchesScope, type ResumeScope, type SessionEnvironment } from "./environment.ts";
import { sessionNameTopic, sessionTargetLabel } from "./session-label.ts";
import type { EnvironmentSession } from "./session-index.ts";
import { matchesArchiveView, sessionStateKey, type ArchiveView, type ResumeState, type ResumeStateStore } from "./resume-state.ts";

const SCOPES: ResumeScope[] = ["environment", "directory", "all"];
const SCOPE_NAMES = { environment: "当前环境", directory: "当前环境＋目录", all: "所有环境（含未知）" };
const ARCHIVE_VIEWS: ArchiveView[] = ["active", "archived", "all"];
const ARCHIVE_NAMES = { active: "未归档", archived: "已归档", all: "含已归档" };
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export type SessionLoader = (
	publish: (rows: EnvironmentSession[], loaded: number, total: number) => void,
	signal: AbortSignal,
) => Promise<EnvironmentSession[]>;

export interface ResumePickerOptions {
	store: ResumeStateStore;
	archiveView?: ArchiveView;
}

export async function showEnvironmentPicker(ctx: ExtensionCommandContext, current: SessionEnvironment, load: SessionLoader,
	options: ResumePickerOptions): Promise<string | undefined> {
	let state = await options.store.load();
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const controller = new AbortController();
		let closed = false;
		let scope: ResumeScope = "environment";
		let archiveView: ArchiveView = options.archiveView ?? "active";
		let rows: EnvironmentSession[] = [];
		let status = "正在加载…";
		let namedOnly = false;
		let showPaths = false;
		let pendingWrites = 0;
		let writes = Promise.resolve();
		const finish = (file?: string) => {
			if (closed) return;
			closed = true;
			controller.abort();
			done(file);
		};
		// Reuse the native searchable/threaded SessionList through its public accessor.
		// Its empty bootstrap completes before our loader starts; no native transcript scan runs.
		const native = new SessionSelectorComponent(async () => [], async () => [], finish, finish, finish,
			() => tui.requestRender(), { keybindings, showRenameHint: false }, ctx.sessionManager.getSessionFile());
		const list = native.getSessionList();
		// Native relevance mode is recent/flat with an empty query. Both it and threaded
		// mode automatically rank search results, without inspecting the private search input.
		const applySort = () => list.setSortMode(state.sort === "recent" ? "relevance" : "threaded");
		applySort();
		const update = () => {
			const sessions = rows.filter((row) => matchesScope(row.environment, current, scope)
				&& matchesArchiveView(state.archived.has(sessionStateKey(row.info)), archiveView))
				.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime())
				.map(({ info, environment }) => {
					const prefix = environment ? sessionTargetLabel(environment.kind === "ssh" ? environment.host : undefined, environment.cwd) : "[UNKNOWN]";
					const archived = state.archived.has(sessionStateKey(info)) ? "[已归档] " : "";
					const label = `${archived}${prefix} ${sessionNameTopic(info.name || info.firstMessage)}`;
					return { ...info, cwd: environment?.cwd ?? info.cwd,
						name: info.name ? label : undefined, firstMessage: info.name ? info.firstMessage : label,
						allMessagesText: `${label} ${info.firstMessage} ${environmentDescription(environment)}` };
				});
			list.setSessions(sessions, true);
			tui.requestRender();
		};
		const persist = (action: () => Promise<{ state: ResumeState; message: string }>) => {
			pendingWrites += 1;
			writes = writes.then(async () => {
				if (closed) return;
				const result = await action();
				state = result.state;
				if (closed) return;
				status = result.message;
				applySort();
				update();
			}).catch((error) => {
				if (!closed) status = `保存失败，请重开列表核对：${String(error)}`;
			}).finally(() => {
				pendingWrites -= 1;
				if (!closed) tui.requestRender();
			});
		};
		list.onToggleScope = () => { scope = SCOPES[(SCOPES.indexOf(scope) + 1) % SCOPES.length]; update(); };
		list.onToggleSort = () => persist(async () => ({
			state: await options.store.setSort(state.sort === "recent" ? "threaded" : "recent"), message: "排序偏好已保存",
		}));
		list.onToggleNameFilter = () => { namedOnly = !namedOnly; list.setNameFilter(namedOnly ? "named" : "all"); };
		list.onTogglePath = (enabled) => { showPaths = enabled; };
		// Deletion/renaming remain in the native /resume. Archiving only changes our sidecar state.
		list.onDeleteSession = undefined;
		list.onRenameSession = undefined;
		void Promise.resolve().then(async () => {
			if (closed) return;
			try {
				rows = await load((partial, loaded, total) => {
					if (closed) return;
					rows = partial;
					status = `正在加载 ${loaded}/${total}…`;
					update();
				}, controller.signal);
				if (closed) return;
				status = `${rows.length} 个会话`;
				update();
			} catch (error) {
				if (closed) return;
				controller.abort();
				status = `加载失败：${String(error)}`;
				tui.requestRender();
			}
		});
		return {
			get focused() { return list.focused; },
			set focused(value: boolean) { list.focused = value; },
			render(width: number) {
				return [
					theme.fg("accent", `恢复会话 — ${SCOPE_NAMES[scope]} · ${state.sort === "recent" ? "最近" : "层级"} · ${ARCHIVE_NAMES[archiveView]}${namedOnly ? " · 仅命名" : ""}`),
					theme.fg("dim", clean(environmentDescription(current))),
					theme.fg("muted", `Tab 范围 · Ctrl+S 最近/层级 · Alt+H 归档视图 · Alt+A 归档/取消归档`),
					theme.fg("muted", `搜索自动按相关性 · Ctrl+N 命名 · Ctrl+P 路径${showPaths ? "(开)" : ""} · Esc 取消`),
					theme.fg("dim", pendingWrites ? "正在保存…" : clean(status)), ...list.render(width),
				].map((line) => truncateToWidth(line, width));
			},
			invalidate() { native.invalidate(); },
			dispose() { closed = true; controller.abort(); },
			handleInput(data: string) {
				if (matchesKey(data, Key.alt("h"))) {
					archiveView = ARCHIVE_VIEWS[(ARCHIVE_VIEWS.indexOf(archiveView) + 1) % ARCHIVE_VIEWS.length];
					update();
				} else if (matchesKey(data, Key.alt("a"))) {
					const selected = rows.find((row) => row.info.path === list.getSelectedSessionPath());
					if (selected) persist(async () => {
						const archived = !state.archived.has(sessionStateKey(selected.info));
						return { state: await options.store.setArchived(selected.info, archived), message: archived ? "已归档（仅此会话）" : "已取消归档" };
					});
				} else if (pendingWrites && keybindings.matches(data, "tui.select.confirm")) {
					status = "正在保存，请稍候";
				} else if ((["app.session.delete", "app.session.deleteNoninvasive", "app.session.rename"] as const)
					.some((action) => keybindings.matches(data, action))) {
					status = "删除或重命名请使用原生 /resume";
				} else list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
