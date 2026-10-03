/**
 * Masked secret entry dialog. Keeps the value in this component only and hands it to `done`.
 * Tab switches to a visible question field, so the user can ask the agent instead of cancelling.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	decodeKittyPrintable,
	type Focusable,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	type OverlayOptions,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MASK = "•";

export interface SecretPrompt {
	title: string;
	label: string;
	/** How to get or set up the secret: where to go, what to choose, what to copy. */
	steps: readonly string[];
	/** The page where the user gets the secret. */
	url?: string;
	/** Labelled facts shown under the steps, e.g. where the value goes and what happens next. */
	rows: ReadonlyArray<readonly [string, string]>;
	/** Shown in the error color under the rows, e.g. an overwrite notice. */
	warning?: string;
	footer: string;
	/** Return an error message to keep the dialog open, or undefined to accept. */
	check: (value: string) => string | undefined;
	/** Lines the dialog may take; the steps are shortened to fit. Default: 85% of the terminal. */
	maxLines?: () => number;
}

/** What the dialog closes with: the secret, or a question the user asked instead. */
export type DialogResult = { kind: "secret"; value: string } | { kind: "question"; text: string };

/**
 * `ctx.ui.custom` options for the dialog. Pi-TUI overlays cannot draw over rows holding terminal
 * images, so `PI_ASK_USER_DISPLAY_MODE=inline` (shared with pi-ask-user) renders it inline instead.
 */
export function dialogOptions(env: NodeJS.ProcessEnv = process.env): { overlay: boolean; overlayOptions?: OverlayOptions } {
	if (env.PI_ASK_USER_DISPLAY_MODE === "inline") return { overlay: false };
	return { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50, maxHeight: "85%", margin: 1 } };
}

function isPrintable(data: string): boolean {
	return [...data].every((ch) => {
		const code = ch.charCodeAt(0);
		return !(code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f));
	});
}

export class SecretInput implements Component, Focusable {
	focused = false;
	private value = "";
	private question = "";
	private mode: "secret" | "question" = "secret";
	private reveal = false;
	private error: string | undefined;
	private inPaste = false;
	private pasteBuffer = "";
	private closed = false;

	private readonly prompt: SecretPrompt;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (result: DialogResult | null) => void;

	constructor(prompt: SecretPrompt, theme: Theme, requestRender: () => void, done: (result: DialogResult | null) => void) {
		this.prompt = prompt;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
	}

	/** Close the dialog without a value, for example when the tool call is aborted. */
	cancel(): void {
		this.finish(null);
	}

	private finish(result: DialogResult | null): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
		this.value = "";
		this.question = "";
		this.pasteBuffer = "";
	}

	private append(text: string): void {
		if (this.mode === "question") this.question += text.replace(/\s*\n\s*/g, " ");
		else this.value += text;
		this.error = undefined;
	}

	private submit(): void {
		if (this.mode === "question") {
			const text = this.question.trim();
			if (!text) {
				this.error = "Type your question first, or press Tab to go back to the secret.";
				this.requestRender();
				return;
			}
			this.finish({ kind: "question", text });
			return;
		}
		const error = this.prompt.check(this.value);
		if (error) {
			this.error = error;
			this.requestRender();
			return;
		}
		this.finish({ kind: "secret", value: this.value });
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data.includes(PASTE_START)) {
			this.inPaste = true;
			this.pasteBuffer = "";
			data = data.replace(PASTE_START, "");
		}
		if (this.inPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf(PASTE_END);
			if (end === -1) return;
			this.append(this.pasteBuffer.slice(0, end).replace(/\r\n?/g, "\n"));
			const rest = this.pasteBuffer.slice(end + PASTE_END.length);
			this.inPaste = false;
			this.pasteBuffer = "";
			if (rest) this.handleInput(rest);
			this.requestRender();
			return;
		}
		if (isKeyRelease(data)) return;

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish(null);
			return;
		}
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			this.submit();
			return;
		}
		const asking = this.mode === "question";
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.mode = asking ? "secret" : "question";
			this.error = undefined;
		} else if (matchesKey(data, "ctrl+r")) {
			if (!asking) this.reveal = !this.reveal;
		} else if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			if (asking) this.question = "";
			else this.value = "";
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			if (asking) this.question = [...this.question].slice(0, -1).join("");
			else this.value = [...this.value].slice(0, -1).join("");
		} else {
			const printable = decodeKittyPrintable(data) ?? (isPrintable(data) ? data : undefined);
			if (printable === undefined) return;
			this.append(printable);
		}
		this.requestRender();
	}

	invalidate(): void {}

	private field(width: number): string {
		const t = this.theme;
		if (this.value.length === 0) return t.fg("dim", "type or paste the secret");
		if (this.reveal) return truncateToWidth(t.fg("warning", this.value.replace(/\n/g, "⏎")), width, "…");
		const count = [...this.value].length;
		return t.fg("accent", MASK.repeat(Math.min(count, Math.max(1, width - 1)))) + (count > width - 1 ? "…" : "");
	}

	/** The numbered steps with hanging indents, then the link. */
	private guide(inner: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		if (this.prompt.steps.length > 0) {
			lines.push(t.bold(t.fg("muted", "How to get it")));
			const indent = `${this.prompt.steps.length}. `.length;
			this.prompt.steps.forEach((step, index) => {
				const marker = `${index + 1}.`.padEnd(indent);
				wrapTextWithAnsi(step, Math.max(10, inner - indent)).forEach((line, i) =>
					lines.push(`${i === 0 ? t.fg("accent", marker) : " ".repeat(indent)}${t.fg("text", line)}`),
				);
			});
		}
		if (this.prompt.url) lines.push(...wrapTextWithAnsi(`${t.fg("muted", "Open  ")}${t.fg("accent", this.prompt.url)}`, inner));
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const asking = this.mode === "question";
		const wrapped = (text: string) => wrapTextWithAnsi(text, inner);

		const head = wrapped(t.bold(t.fg("text", this.prompt.label)));
		const facts: string[] = [];
		const pad = Math.max(0, ...this.prompt.rows.map(([name]) => name.length)) + 2;
		for (const [name, value] of this.prompt.rows)
			wrapTextWithAnsi(value, Math.max(10, inner - pad)).forEach((line, i) =>
				facts.push(`${i === 0 ? t.fg("muted", name.padEnd(pad)) : " ".repeat(pad)}${t.fg("text", line)}`),
			);
		if (this.prompt.warning) facts.push(...wrapped(t.bold(t.fg("error", `⚠ ${this.prompt.warning}`))));

		const entry: string[] = [];
		const secretMarker = asking ? t.fg("dim", "  ") : t.fg("accent", "› ");
		entry.push(`${secretMarker}${this.field(inner - 2)}`);
		const chars = [...this.value].length;
		const lines = this.value.length === 0 ? 0 : this.value.split("\n").length;
		entry.push(t.fg("dim", `  ${chars} char${chars === 1 ? "" : "s"}${lines > 1 ? `, ${lines} lines` : ""}`));
		if (asking) {
			if (this.question)
				wrapTextWithAnsi(t.fg("text", this.question), inner - 2).forEach((line, i) =>
					entry.push(`${i === 0 ? t.fg("accent", "? ") : "  "}${line}`),
				);
			else entry.push(`${t.fg("accent", "? ")}${t.fg("dim", "ask the agent instead; visible and sent to the chat")}`);
		}
		if (this.error) entry.push(...wrapped(t.fg("error", this.error)));

		const help = wrapped(
			t.fg(
				"dim",
				asking
					? "Enter send question (nothing is staged) · Tab back to the secret · Esc cancel · Ctrl+U clear"
					: "Enter stage · Tab ask a question instead · Esc cancel · Ctrl+R show/hide · Ctrl+U clear",
			),
		);
		const footer = wrapped(t.fg("dim", this.prompt.footer));

		// The overlay cuts off its bottom, where the input is, so long steps give way instead.
		const fixed = head.length + facts.length + entry.length + help.length + footer.length + 4 + 2;
		const budget = (this.prompt.maxLines ?? defaultMaxLines)() - fixed;
		let guide = this.guide(inner);
		if (guide.length > 0 && guide.length + 1 > budget) {
			const keep = Math.max(0, budget - 2);
			const hidden = guide.length - keep;
			guide = [...guide.slice(0, keep), t.fg("warning", `… ${hidden} more line${hidden === 1 ? "" : "s"}; the full steps are in the chat above`)];
		}

		const body = [...head, "", ...(guide.length > 0 ? [...guide, ""] : []), ...facts, "", ...entry, "", ...help, ...footer];

		const border = (s: string) => t.fg("borderAccent", s);
		const title = ` ${this.prompt.title} `;
		const top = border(`╭─${title}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}─╮`);
		const bottom = border(`╰${"─".repeat(inner + 2)}╯`);
		const rows = body.map((line) => {
			const fitted = truncateToWidth(line, inner, "…");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		});
		return [top, ...rows, bottom];
	}
}

/** 85% of the terminal's rows, as the overlay allows, less its margin. */
function defaultMaxLines(): number {
	return Math.max(12, Math.floor((process.stdout.rows || 40) * 0.85) - 2);
}
