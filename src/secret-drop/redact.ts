/**
 * Replace known secret values anywhere in tool output or conversation messages.
 */

export const REDACTED = "[REDACTED]";
/** Shorter values would redact ordinary text. */
export const MIN_REDACT_LENGTH = 4;
/** Lines of a multi-line secret this long are redacted on their own too. */
const MIN_LINE_LENGTH = 16;

export class Redactor {
	private values = new Set<string>();

	add(secret: string): void {
		const normalized = secret.replace(/\r\n/g, "\n");
		for (const candidate of [secret, normalized, normalized.trim()]) {
			if (candidate.length >= MIN_REDACT_LENGTH) this.values.add(candidate);
		}
		if (normalized.includes("\n")) {
			for (const line of normalized.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length >= MIN_LINE_LENGTH) this.values.add(trimmed);
			}
		}
	}

	get size(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	redactText(text: string): string {
		if (this.values.size === 0) return text;
		let result = text;
		// Longest first so a full secret wins over its individual lines.
		for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
			if (result.includes(value)) result = result.split(value).join(REDACTED);
		}
		return result;
	}

	/** Deep-copy `input`, redacting every string. Returns the same reference when nothing changed. */
	redactDeep<T>(input: T): T {
		if (this.values.size === 0) return input;
		return this.walk(input) as T;
	}

	private walk(node: unknown): unknown {
		if (typeof node === "string") return this.redactText(node);
		if (Array.isArray(node)) {
			let changed = false;
			const next = node.map((item) => {
				const out = this.walk(item);
				if (out !== item) changed = true;
				return out;
			});
			return changed ? next : node;
		}
		if (node !== null && typeof node === "object") {
			const proto = Object.getPrototypeOf(node);
			if (proto !== Object.prototype && proto !== null) return node;
			let changed = false;
			const next: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(node)) {
				const out = this.walk(value);
				if (out !== value) changed = true;
				next[key] = out;
			}
			return changed ? next : node;
		}
		return node;
	}
}
