/** What the agent hands over, and how each of the user's choices turns into editor or clipboard text. */

export type Kind = "shell" | "pi";
export type Choice = "prompt" | "clipboard" | "cancel";

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

/**
 * The choices shown to the user. The clipboard needs the local terminal and only makes sense for a
 * shell command run elsewhere; a pi command only runs inside pi.
 */
export function options(offer: Offer, hasDraft: boolean, canCopy: boolean): Option[] {
	const list: Option[] = [{ choice: "prompt", label: hasDraft ? "Put it in my prompt (replaces my draft)" : "Put it in my prompt" }];
	if (canCopy && offer.kind === "shell") list.push({ choice: "clipboard", label: "Copy it to the clipboard" });
	list.push({ choice: "cancel", label: "No, thanks" });
	return list;
}

/** The selector title: why the agent hands this over, then exactly what the user would run. */
export function dialogTitle(offer: Offer, reason: string): string {
	return `Robot Hand — ${reason}\n\n  ${promptText(offer).split("\n").join("\n  ")}`;
}

/** What the tool tells the agent after the user chose. */
export function resultText(choice: Choice, offer: Offer): string {
	if (choice === "prompt") {
		const output = offer.kind === "shell" ? " Its output appears in the conversation when they run it." : "";
		return `The user put \`${promptText(offer)}\` in their prompt; it runs only when they press Enter.${output} Nothing has run yet; wait for the user.`;
	}
	if (choice === "clipboard") {
		return "The user copied the command to their clipboard to run it themselves. Nothing has run yet; wait for the user to report the result.";
	}
	return "The user declined; nothing was placed or run. Ask how they want to proceed.";
}
