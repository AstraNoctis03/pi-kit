import { DynamicBorder, keyText, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	type Focusable,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIRMATION_COLORS,
	loadConfirmationColors,
	paintConfirmationColor,
	type ConfirmationColors,
} from "./dialog-colors.ts";

// Approval text must expose control-sequence payloads, not silently discard
// them: a hidden OSC body could contain shell operators the user must inspect.
function confirmationText(text: string): string {
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => {
		const code = character.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

export interface ConfirmationOptions {
	allowFeedback?: boolean;
}

export interface SafetyConfirmationResult {
	allowed: boolean;
	feedback?: string;
}

const YES = "yes";
const NO = "no";
let reportedColorError: string | undefined;

export class SafetyDialog implements Focusable {
	private readonly container = new Container();
	private readonly input = new Input();
	private readonly list: SelectList;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly reason: string;
	private readonly subject: string;
	private readonly done: (result: SafetyConfirmationResult) => void;
	private readonly colors: ConfirmationColors;
	private readonly allowFeedback: boolean;
	private mode: "select" | "input" = "select";
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "input";
	}

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		reason: string,
		subject: string,
		done: (result: SafetyConfirmationResult) => void,
		colors: ConfirmationColors = DEFAULT_CONFIRMATION_COLORS,
		options: ConfirmationOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.reason = reason;
		this.subject = subject;
		this.done = done;
		this.colors = colors;
		this.allowFeedback = options.allowFeedback !== false;
		const items: SelectItem[] = [
			{ value: YES, label: "确认" },
			{ value: NO, label: "取消" },
		];
		this.list = new SelectList(items, items.length, {
			selectedPrefix: (text) => paintConfirmationColor(theme, colors.selected, theme.bold(text)),
			selectedText: (text) => paintConfirmationColor(theme, colors.selected, theme.bold(text)),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.list.setSelectedIndex(0);
		this.list.onSelect = (item) => this.done({ allowed: item.value === YES });
		this.list.onCancel = () => this.done({ allowed: false });
		this.list.onSelectionChange = () => this.rebuild();
		this.input.onSubmit = (value) => {
			const feedback = value.trim();
			this.done({ allowed: false, feedback: feedback || undefined });
		};
		this.input.onEscape = () => {
			this.mode = "select";
			this.input.focused = false;
			this.rebuild();
			this.tui.requestRender();
		};
		this.rebuild();
	}

	handleInput(data: string): void {
		if (this.mode === "input") {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.allowFeedback && matchesKey(data, "tab") && this.list.getSelectedItem()?.value === NO) {
			this.mode = "input";
			this.input.focused = this.focused;
			this.rebuild();
			this.tui.requestRender();
			return;
		}
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const panelWidth = Math.min(width, 88);
		return this.container.render(panelWidth).map((line) => truncateToWidth(line, panelWidth, "…"));
	}

	invalidate(): void {
		this.container.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		const border = () => new DynamicBorder((text: string) =>
			paintConfirmationColor(this.theme, this.colors.border, text));
		const titles = new Map([
			["Safety confirmation", "安全确认"],
			["Sensitive path confirmation", "敏感路径确认"],
			["Uncommitted changes", "未提交的改动"],
		]);
		const separatorIndex = this.subject.indexOf(": ");
		const rawLabel = separatorIndex > 0 ? this.subject.slice(0, separatorIndex) : "Operation";
		const label = new Map([["Command", "命令"], ["Path", "路径"], ["Action", "操作"], ["Operation", "操作"]]).get(rawLabel) ?? rawLabel;
		const value = separatorIndex > 0 ? this.subject.slice(separatorIndex + 2) : this.subject;
		const key = (action: Parameters<typeof keyText>[0]) => keyText(action) || "未绑定";

		this.container.clear();
		this.container.addChild(border());
		this.container.addChild(new Text(
			paintConfirmationColor(this.theme, this.colors.title, this.theme.bold("⚠ " + confirmationText(titles.get(this.title) ?? this.title))),
			1,
			0,
		));
		this.container.addChild(new Text(this.theme.fg("text", confirmationText(this.reason)), 1, 0));
		if (this.subject) {
			this.container.addChild(new Spacer(1));
			this.container.addChild(new Text(this.theme.fg("muted", confirmationText(label)), 1, 0));
			// Wrap the entire operation, never replace it with a shortened summary.
			this.container.addChild(new Text(this.theme.fg("text", confirmationText(value)), 1, 0));
		}
		this.container.addChild(new Spacer(1));
		const controls = new Box(1, 0);
		if (this.mode === "select") {
			controls.addChild(this.list);
			const canExplain = this.allowFeedback && this.list.getSelectedItem()?.value === NO;
			const help = `${key("tui.select.up")}/${key("tui.select.down")} 选择 · ${key("tui.select.confirm")} 确认 · ${key("tui.select.cancel")} 取消`
				+ (canExplain ? " · tab 补充原因" : "");
			controls.addChild(new Text(this.theme.fg("muted", help), 0, 0));
		} else {
			controls.addChild(new Text(this.theme.fg("muted", "补充拒绝原因（可留空）"), 0, 0));
			controls.addChild(this.input);
			controls.addChild(new Text(this.theme.fg("muted", `${key("tui.input.submit")} 拒绝并提交 · ${key("tui.select.cancel")} 返回`), 0, 0));
		}
		this.container.addChild(controls);
		this.container.addChild(border());
	}
}

export async function showThemedConfirmation(
	ctx: ExtensionContext,
	title: string,
	reason: string,
	subject: string,
	options: ConfirmationOptions = {},
): Promise<SafetyConfirmationResult> {
	if (!ctx.hasUI) return { allowed: false };
	if (ctx.mode !== "tui") {
		const allowed = await ctx.ui.confirm(title, subject ? `${reason}\n\n${subject}` : reason);
		return { allowed };
	}

	const loaded = loadConfirmationColors();
	if (loaded.error && loaded.error !== reportedColorError) {
		reportedColorError = loaded.error;
		ctx.ui.notify(`Confirmation color config is invalid; using defaults: ${loaded.error}`, "warning");
	}
	if (!loaded.error) reportedColorError = undefined;
	return ctx.ui.custom<SafetyConfirmationResult>((tui, theme, _keybindings, done) =>
		new SafetyDialog(tui, theme, title, reason, subject, done, loaded.colors, options));
}

export function showSafetyConfirmation(
	ctx: ExtensionContext,
	reason: string,
	subject: string,
): Promise<SafetyConfirmationResult> {
	return showThemedConfirmation(ctx, "Safety confirmation", reason, subject);
}
