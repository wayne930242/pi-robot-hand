/**
 * Untrusted text made safe to draw in the terminal. File names, script names, a checker's words, and an
 * agent's command can hold escape sequences that move the cursor, recolor, or erase what was drawn, carriage
 * returns that draw over a line, and bidirectional or invisible characters that make text read differently from
 * what runs. Each such character is shown as a visible `\u{…}` escape instead.
 */

// Controls and format characters (bidirectional marks, zero-width characters, tag characters, soft hyphens),
// line and paragraph separators, spaces other than the ASCII one (which split words differently from what
// runs), variation selectors, blank fillers and the blank braille cell, and runs of three or more combining
// marks, which can stack over other text.
const HIDDEN = /\p{M}{3,}|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u115f\u1160\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

function escape(chars: string): string {
	return [...chars].map((char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`).join("");
}

/** The text with hidden characters escaped; newlines and tabs stay unless `oneLine`. */
export function printable(text: string, oneLine = false): string {
	return text.replace(HIDDEN, (char) => (!oneLine && (char === "\n" || char === "\t") ? char : escape(char)));
}
