/** What the agent hands over, and how each of the user's choices turns into editor or clipboard text. */

export type Kind = "shell" | "pi";
export type Preferred = "prompt" | "clipboard" | "herdr-type" | "herdr-run";
export type Choice = Preferred | "cancel";

/** Where the hand-over can go in this session. */
export interface Reach {
	hasDraft: boolean;
	/** The local terminal UI, where the clipboard works. */
	canCopy: boolean;
	/** pi runs inside a Herdr pane, so a sibling pane can be opened. */
	inHerdr: boolean;
}

export interface Offer {
	command: string;
	kind: Kind;
}

export interface Option {
	choice: Choice;
	label: string;
}

/** Checks the command and fills in the default kind. Throws with a message the agent can act on. */
export function toOffer(command: string, kind: Kind | undefined): Offer {
	const text = command.trim();
	if (text.length === 0) throw new Error("`command` is empty.");
	const resolved = kind ?? "shell";
	if (resolved === "shell" && text.startsWith("!")) {
		throw new Error("Pass the shell command without a leading `!`; robot_hand adds it when the command goes to the prompt.");
	}
	if (resolved === "pi" && !text.startsWith("/")) {
		throw new Error("kind=pi takes a pi slash command such as `/reload`; use kind=shell for shell commands.");
	}
	return { command: text, kind: resolved };
}

/** The text placed in the pi prompt: shell commands run through pi's `!` prefix, pi commands go as-is. */
export function promptText(offer: Offer): string {
	return offer.kind === "shell" ? `! ${offer.command}` : offer.command;
}

// When the preferred choice is unavailable, the next one in its chain leads instead.
const FALLBACK: Record<Preferred, Preferred[]> = {
	prompt: ["prompt"],
	clipboard: ["clipboard", "prompt"],
	"herdr-type": ["herdr-type", "clipboard", "prompt"],
	"herdr-run": ["herdr-run", "herdr-type", "clipboard", "prompt"],
};

/**
 * The choices shown to the user, the preferred one first so the cursor starts on it. The clipboard
 * needs the local terminal and Herdr panes need pi inside Herdr; both only make sense for a shell
 * command, since a pi command only runs inside pi.
 */
export function options(offer: Offer, reach: Reach, preferred: Preferred = "prompt"): Option[] {
	const shell = offer.kind === "shell";
	const list: Option[] = [{ choice: "prompt", label: reach.hasDraft ? "Put it in my prompt (replaces my draft)" : "Put it in my prompt" }];
	if (shell && reach.canCopy) list.push({ choice: "clipboard", label: "Copy it to the clipboard" });
	if (shell && reach.inHerdr) {
		list.push({ choice: "herdr-type", label: "Type it into a new Herdr pane (I press Enter)" });
		list.push({ choice: "herdr-run", label: "Run it in a new Herdr pane" });
	}
	const lead = FALLBACK[preferred].find((choice) => list.some((option) => option.choice === choice)) ?? "prompt";
	const ordered = [...list.filter((option) => option.choice === lead), ...list.filter((option) => option.choice !== lead)];
	return [...ordered, { choice: "cancel", label: "No, thanks" }];
}

/** The selector title: why the agent hands this over, then exactly what the user would run. */
export function dialogTitle(offer: Offer, reason: string): string {
	return `Robot Hand — ${reason}\n\n  ${promptText(offer).split("\n").join("\n  ")}`;
}

/** What the tool tells the agent after the user chose. */
export function resultText(choice: Choice, offer: Offer): string {
	if (choice === "prompt") {
		const output = offer.kind === "shell" ? " When they run it, its output returns to the conversation and starts your next turn." : "";
		return `The user put \`${promptText(offer)}\` in their prompt; it runs only when they press Enter.${output} Nothing has run yet; wait for the user.`;
	}
	if (choice === "clipboard") {
		return "The user copied the command to their clipboard to run it themselves. Nothing has run yet; wait for the user to report the result.";
	}
	if (choice === "herdr-type" || choice === "herdr-run") {
		const state = choice === "herdr-run" ? "It is running there" : "It runs when the user presses Enter there";
		return `The command is in a new Herdr pane. ${state}; when it finishes, the pane closes and its output arrives as a new message. Wait for that message.`;
	}
	return "The user declined; nothing was placed or run. Ask how they want to proceed.";
}
