import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIRMATION_COLORS,
	loadConfirmationColors,
	paintConfirmationColor,
	type ConfirmationColors,
} from "./dialog-colors.ts";

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
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.reason = reason;
		this.subject = subject;
		this.done = done;
		this.colors = colors;
		const items: SelectItem[] = [
			{ value: YES, label: "Yes" },
			{ value: NO, label: "No" },
		];
		this.list = new SelectList(items, items.length, {
			selectedPrefix: (text) => paintConfirmationColor(theme, colors.selected, theme.bold(text)),
			selectedText: (text) => paintConfirmationColor(theme, colors.selected, theme.bold(text)),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.list.setSelectedIndex(1);
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
		if (matchesKey(data, "tab") && this.list.getSelectedItem()?.value === NO) {
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
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		const border = () => new DynamicBorder((text: string) =>
			paintConfirmationColor(this.theme, this.colors.border, text));
		const separatorIndex = this.subject.indexOf(": ");
		const label = separatorIndex > 0 ? this.subject.slice(0, separatorIndex) : "Operation";
		const value = separatorIndex > 0 ? this.subject.slice(separatorIndex + 2) : this.subject;

		this.container.clear();
		this.container.addChild(border());
		this.container.addChild(new Text(
			paintConfirmationColor(this.theme, this.colors.title, this.theme.bold(this.title)),
			1,
			0,
		));
		this.container.addChild(new Text(this.theme.fg("text", this.reason), 1, 1));
		this.container.addChild(new Text(this.theme.fg("muted", label), 1, 0));
		this.container.addChild(new Text(this.theme.fg("text", value), 1, 1));

		if (this.mode === "select") {
			this.container.addChild(this.list);
			const canExplain = this.list.getSelectedItem()?.value === NO;
			const help = canExplain
				? "↑↓ choose  •  enter confirm  •  tab explain  •  esc reject"
				: "↑↓ choose  •  enter confirm  •  esc reject";
			this.container.addChild(new Text(this.theme.fg("muted", help), 1, 1));
		} else {
			this.container.addChild(new Text(this.theme.fg("muted", "Tell what's wrong"), 1, 0));
			this.container.addChild(this.input);
			this.container.addChild(new Text(this.theme.fg("muted", "enter submit  •  esc back"), 1, 1));
		}
		this.container.addChild(border());
	}
}

export async function showThemedConfirmation(
	ctx: ExtensionContext,
	title: string,
	reason: string,
	subject: string,
): Promise<SafetyConfirmationResult> {
	if (!ctx.hasUI) return { allowed: false };
	if (ctx.mode !== "tui") {
		const allowed = await ctx.ui.confirm(title, `${reason}\n\n${subject}`);
		return { allowed };
	}

	const loaded = loadConfirmationColors();
	if (loaded.error && loaded.error !== reportedColorError) {
		reportedColorError = loaded.error;
		ctx.ui.notify(`Confirmation color config is invalid; using defaults: ${loaded.error}`, "warning");
	}
	if (!loaded.error) reportedColorError = undefined;
	return ctx.ui.custom<SafetyConfirmationResult>((tui, theme, _keybindings, done) =>
		new SafetyDialog(tui, theme, title, reason, subject, done, loaded.colors));
}

export function showSafetyConfirmation(
	ctx: ExtensionContext,
	reason: string,
	subject: string,
): Promise<SafetyConfirmationResult> {
	return showThemedConfirmation(ctx, "Safety confirmation", reason, subject);
}
