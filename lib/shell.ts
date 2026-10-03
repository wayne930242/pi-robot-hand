/**
 * POSIX shell quoting for the commands shown to and run by the user.
 */

const SAFE = /^[A-Za-z0-9_\-.,/:@%+=]+$/;

export function shellQuote(word: string): string {
	return SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
