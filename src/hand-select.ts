/**
 * robot_hand's selector in the terminal: the hand-over title, the choices, and the `e` check.
 * `e` checks with the saved model, or opens the model list when none is saved, the saved one is
 * gone, or the last check failed; `E` always opens the list. The check never closes the selector.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, type Focusable, getKeybindings, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CheckResult, Verdict } from "./check.ts";

export interface HandSelectProps {
	/** The same title the plain selector shows: the reason, a blank line, then the command. */
	title: string;
	labels: readonly string[];
	/** `provider/id` of every signed-in model. */
	models: () => string[];
	/** The saved check model. */
	saved: () => string | undefined;
	/** Remembers the model the user picked. */
	pick: (model: string) => void;
	/** Checks the command with a model; rejects with a message the user can act on. Aborted when superseded or closed. */
	check: (model: string, signal: AbortSignal) => Promise<CheckResult>;
	/** Lines the selector may take; the command and check give way first. Default: 85% of the terminal. */
	maxLines?: () => number;
}

type State =
	| { kind: "idle" }
	| { kind: "checking"; model: string }
	| { kind: "done"; result: CheckResult }
	| { kind: "failed"; model: string; error: string };

const MAX_LISTED = 8;
const MARK: Record<Verdict, { icon: string; color: "success" | "warning" | "error" | "muted"; text: string }> = {
	match: { icon: "✓", color: "success", text: "Matches the stated intent" },
	partial: { icon: "!", color: "warning", text: "Partly matches the stated intent" },
	mismatch: { icon: "✗", color: "error", text: "Does not match the stated intent" },
	unclear: { icon: "?", color: "muted", text: "The checker's answer was not in the expected form" },
};

export class HandSelect implements Component, Focusable {
	focused = false;
	private cursor = 0;
	private state: State = { kind: "idle" };
	private picker: { filter: string; cursor: number } | undefined;
	private closed = false;
	private running: AbortController | undefined;

	readonly props: HandSelectProps;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (index: number | undefined) => void;

	constructor(props: HandSelectProps, theme: Theme, requestRender: () => void, done: (index: number | undefined) => void) {
		this.props = props;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
	}

	/** The last finished check, for the tool's result. */
	get result(): CheckResult | undefined {
		return this.state.kind === "done" ? this.state.result : undefined;
	}

	/** Closes without a choice, for example on abort or a remote answer. */
	cancel(): void {
		this.finish(undefined);
	}

	private finish(index: number | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.running?.abort();
		this.done(index);
	}

	private listed(): string[] {
		const filter = this.picker?.filter.toLowerCase() ?? "";
		return this.props.models().filter((model) => model.toLowerCase().includes(filter));
	}

	private openPicker(): void {
		const saved = this.props.saved();
		const at = saved ? this.props.models().indexOf(saved) : -1;
		this.picker = { filter: "", cursor: Math.max(0, at) };
	}

	private startCheck(model: string): void {
		this.running?.abort();
		const run = new AbortController();
		this.running = run;
		this.state = { kind: "checking", model };
		this.props.check(model, run.signal).then(
			(result) => {
				if (this.closed || run !== this.running) return;
				this.state = { kind: "done", result };
				this.requestRender();
			},
			(error: unknown) => {
				if (this.closed || run !== this.running) return;
				this.state = { kind: "failed", model, error: error instanceof Error ? error.message : String(error) };
				this.requestRender();
			},
		);
	}

	private pickerInput(data: string): void {
		const picker = this.picker;
		if (!picker) return;
		const kb = getKeybindings();
		const list = this.listed();
		if (kb.matches(data, "tui.select.cancel")) {
			this.picker = undefined;
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const model = list[picker.cursor];
			if (!model) return;
			this.picker = undefined;
			this.props.pick(model);
			this.startCheck(model);
		} else if (kb.matches(data, "tui.select.up")) {
			picker.cursor = list.length === 0 ? 0 : (picker.cursor - 1 + list.length) % list.length;
		} else if (kb.matches(data, "tui.select.down")) {
			picker.cursor = list.length === 0 ? 0 : (picker.cursor + 1) % list.length;
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			picker.filter = [...picker.filter].slice(0, -1).join("");
			picker.cursor = 0;
		} else {
			const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
			if (printable === undefined) return;
			picker.filter += printable;
			picker.cursor = 0;
		}
		this.requestRender();
	}

	handleInput(data: string): void {
		if (this.closed || isKeyRelease(data)) return;
		if (this.picker) {
			this.pickerInput(data);
			return;
		}
		const kb = getKeybindings();
		const count = this.props.labels.length;
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.finish(this.cursor);
			return;
		}
		// Like pi's selector: j and k move too, and the cursor stops at the ends.
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.cursor = Math.max(0, this.cursor - 1);
		} else if (kb.matches(data, "tui.select.down") || data === "j") {
			this.cursor = Math.min(count - 1, this.cursor + 1);
		} else if (data === "E" || matchesKey(data, "shift+e")) {
			this.openPicker();
		} else if (data === "e" || matchesKey(data, "e")) {
			if (this.state.kind === "checking") return;
			const saved = this.props.saved();
			if (!saved || this.state.kind === "failed" || !this.props.models().includes(saved)) this.openPicker();
			else this.startCheck(saved);
		} else {
			return;
		}
		this.requestRender();
	}

	invalidate(): void {}

	private checkLines(inner: number): string[] {
		const t = this.theme;
		const wrap = (text: string) => wrapTextWithAnsi(text, inner);
		const state = this.state;
		if (state.kind === "checking") return wrap(t.fg("muted", `Checking with ${state.model}…`));
		if (state.kind === "failed") {
			return [...wrap(t.fg("error", `${state.model} could not check: ${state.error}`)), ...wrap(t.fg("dim", "Press e to pick another model."))];
		}
		if (state.kind !== "done") return [];
		const { result } = state;
		const mark = MARK[result.verdict];
		const lines = wrap(`${t.bold(t.fg(mark.color, `${mark.icon} ${mark.text}`))} ${t.fg("dim", `— ${result.model}`)}`);
		if (result.does) lines.push(...wrap(t.fg("text", result.does)));
		if (result.gaps) lines.push(...wrap(t.fg("warning", result.gaps)));
		return lines;
	}

	private pickerLines(inner: number): string[] {
		const t = this.theme;
		const picker = this.picker;
		if (!picker) return [];
		const list = this.listed();
		const lines = [t.bold(t.fg("muted", "Check with which model?")), `${t.fg("muted", "Filter: ")}${picker.filter ? t.fg("text", picker.filter) : t.fg("dim", "type part of a name")}`];
		if (this.props.models().length === 0) lines.push(...wrapTextWithAnsi(t.fg("warning", "No signed-in model; sign in with /login first."), inner));
		else if (list.length === 0) lines.push(t.fg("dim", "  no model matches"));
		const first = Math.max(0, Math.min(picker.cursor - Math.floor(MAX_LISTED / 2), list.length - MAX_LISTED));
		list.slice(first, first + MAX_LISTED).forEach((model, i) => {
			const at = first + i === picker.cursor;
			const saved = model === this.props.saved() ? t.fg("dim", " (saved)") : "";
			lines.push(`${at ? t.fg("accent", "› ") : "  "}${t.fg(at ? "accent" : "text", model)}${saved}`);
		});
		if (list.length > MAX_LISTED) lines.push(t.fg("dim", `  ${list.length} models; type to narrow`));
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const wrap = (text: string) => wrapTextWithAnsi(text, inner);

		const [head = "", ...rest] = this.props.title.split("\n");
		const heading = wrap(t.bold(t.fg("text", head)));
		let command = rest.map((line) => t.fg("accent", line));
		const choices = this.props.labels.map((label, i) => (i === this.cursor && !this.picker ? `${t.fg("accent", "› ")}${t.fg("accent", label)}` : `  ${t.fg("text", label)}`));
		const saved = this.props.saved();
		const help = wrap(
			t.fg(
				"dim",
				this.picker
					? "↑↓ move · Enter check with this model · Esc back"
					: `↑↓ move · Enter choose · e check with ${saved && this.state.kind !== "failed" ? saved : "a model"} · E change model · Esc cancel`,
			),
		);
		const check = this.picker ? this.pickerLines(inner) : this.checkLines(inner);

		// Keep the choices and help on screen; the command gives way before the check does.
		const budget = (this.props.maxLines ?? defaultMaxLines)() - 2;
		const fixed = heading.length + choices.length + help.length + (check.length > 0 ? check.length + 1 : 0) + 3;
		if (command.length > 0 && fixed + command.length > budget) {
			const keep = Math.max(1, budget - fixed - 1);
			const hidden = command.length - keep;
			if (hidden > 0) command = [...command.slice(0, keep), t.fg("warning", `  … ${hidden} more line${hidden === 1 ? "" : "s"}; the full command is in the chat above`)];
		}

		const body = [...heading, ...command, "", ...(check.length > 0 ? [...check, ""] : []), ...choices, "", ...help];
		const border = (s: string) => t.fg("borderAccent", s);
		const top = border(`╭${"─".repeat(inner + 2)}╮`);
		const bottom = border(`╰${"─".repeat(inner + 2)}╯`);
		const rows = body.map((line) => {
			const fitted = truncateToWidth(line, inner, "…");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		});
		return [top, ...rows, bottom];
	}
}

function defaultMaxLines(): number {
	return Math.max(12, Math.floor((process.stdout.rows || 40) * 0.85) - 2);
}
