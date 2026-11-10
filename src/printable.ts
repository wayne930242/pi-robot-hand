/**
 * Untrusted text made safe to draw in the terminal. File names, script names, a checker's words, and an
 * agent's command can hold escape sequences that move the cursor, recolor, or erase what was drawn, carriage
 * returns that draw over a line, and bidirectional or invisible characters that make text read differently from
 * what runs. Each such character is shown as a visible `\u{…}` escape instead.
 */

// C0 and C1 controls (tab and newline aside), the bidirectional marks, embeddings, overrides, and isolates,
// zero-width characters, line and paragraph separators, and the byte order mark.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function escape(char: string): string {
	return `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
}

/** The text with hidden characters escaped; newlines and tabs stay unless `oneLine`. */
export function printable(text: string, oneLine = false): string {
	const shown = text.replace(HIDDEN, escape);
	return oneLine ? shown.replace(/[\n\t]/g, escape) : shown;
}
