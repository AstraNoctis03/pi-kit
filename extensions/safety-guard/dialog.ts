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

export interface SafetyConfirmationResult {
	allowed: boolean;
	feedback?: string;
}

const YES = "yes";
const NO = "no";

class SafetyDialog implements Focusable {
	private readonly container = new Container();
	private readonly input = new Input();
	private readonly list: SelectList;
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
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly reason: string,
		private readonly subject: string,
		private readonly done: (result: SafetyConfirmationResult) => void,
	) {
		const items: SelectItem[] = [
			{ value: YES, label: "Yes" },
			{ value: NO, label: "No" },
		];
		this.list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
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
		const border = () => new DynamicBorder((text: string) => this.theme.fg("borderMuted", text));
		const separatorIndex = this.subject.indexOf(": ");
		const label = separatorIndex > 0 ? this.subject.slice(0, separatorIndex) : "Operation";
		const value = separatorIndex > 0 ? this.subject.slice(separatorIndex + 2) : this.subject;

		this.container.clear();
		this.container.addChild(border());
		this.container.addChild(new Text(this.theme.fg("warning", this.theme.bold("Safety confirmation")), 1, 0));
		this.container.addChild(new Text(this.theme.fg("muted", this.reason), 1, 1));
		this.container.addChild(new Text(this.theme.fg("dim", label), 1, 0));
		this.container.addChild(new Text(this.theme.fg("text", value), 1, 1));

		if (this.mode === "select") {
			this.container.addChild(this.list);
			const canExplain = this.list.getSelectedItem()?.value === NO;
			const help = canExplain
				? "↑↓ choose  •  enter confirm  •  tab explain  •  esc reject"
				: "↑↓ choose  •  enter confirm  •  esc reject";
			this.container.addChild(new Text(this.theme.fg("dim", help), 1, 1));
		} else {
			this.container.addChild(new Text(this.theme.fg("dim", "Tell what's wrong"), 1, 0));
			this.container.addChild(this.input);
			this.container.addChild(new Text(this.theme.fg("dim", "enter submit  •  esc back"), 1, 1));
		}
		this.container.addChild(border());
	}
}

export async function showSafetyConfirmation(
	ctx: ExtensionContext,
	reason: string,
	subject: string,
): Promise<SafetyConfirmationResult> {
	if (!ctx.hasUI) return { allowed: false };
	if (ctx.mode !== "tui") {
		const allowed = await ctx.ui.confirm("Safety confirmation", `${reason}\n\n${subject}`);
		return { allowed };
	}

	return ctx.ui.custom<SafetyConfirmationResult>((tui, theme, _keybindings, done) =>
		new SafetyDialog(tui, theme, reason, subject, done));
}
