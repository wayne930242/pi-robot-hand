// Dialog contract v1, owner side: robot_hand publishes the selector it opens and accepts one valid answer from another
// extension through the path a terminal pick takes. The first of pick, answer, Escape, or abort wins; answers are checked
// against this call's own copy of the dialog.
import { createHash, randomUUID } from "node:crypto";

export interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface BusChoice { label: string; note?: string; localOnly?: true }
type By = "local" | "remote" | "cancel" | "timeout" | "abort" | "error";
type Reason = "closed" | "digest" | "malformed" | "not-allowed";
const PREFIX = "robot-hand";
const ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/;
const KEYS = new Set(["version", "id", "answerId", "digest", "selections", "text", "comment"]);

/** SHA-256 of the canonical select form: the title and the choice labels, nothing else. */
export function digestOf(title: string, labels: string[]): string {
	return createHash("sha256").update(JSON.stringify(["pi-dialog/1", "select", title, labels]), "utf8").digest("hex");
}

// A selector takes exactly one index: no words, no comment. Returns that index, or why the whole answer is refused.
function check(a: Record<string, unknown>, digest: string, count: number): number | Reason {
	const { selections, text, comment } = a;
	const has = (key: string): boolean => Object.hasOwn(a, key);
	const picks = Array.isArray(selections) ? [...selections] : [];
	const picksOk = picks.length > 0 && new Set(picks).size === picks.length && picks.every((i) => Number.isInteger(i) && i >= 0 && i < count);
	const shaped =
		a.version === 1 && typeof a.answerId === "string" && ANSWER_ID.test(a.answerId) && typeof a.digest === "string" && Object.keys(a).every((key) => KEYS.has(key)) &&
		has("selections") !== has("text") &&
		(!has("selections") || picksOk) &&
		(!has("text") || (typeof text === "string" && text.trim() !== "")) &&
		(!has("comment") || (typeof comment === "string" && has("selections")));
	if (!shaped) return "malformed";
	if (a.digest !== digest) return "digest";
	return !has("text") && !has("comment") && picks.length === 1 ? (picks[0] as number) : "not-allowed";
}

export function openDialog(bus: Bus, o: { toolCallId: string; title: string; choices: BusChoice[]; copy: string; signal?: AbortSignal }) {
	const id = randomUUID();
	const digest = digestOf(o.title, o.choices.map((choice) => choice.label));
	const local = new AbortController();
	let by: By | undefined;
	let winner: number | undefined;
	// The flag is written before anything is closed or emitted, so the other claimant sees "closed".
	const settle = (how: By, answerId?: string, between?: () => void): void => {
		if (by) return;
		by = how;
		between?.();
		bus.emit(`${PREFIX}:closed`, { version: 1, id, by: how, ...(answerId ? { answerId } : {}) });
	};
	const onAbort = (): void => settle("abort");
	const off = bus.on(`${PREFIX}:answer`, (raw) => {
		if (typeof raw !== "object" || raw === null) return;
		const a = { ...raw } as Record<string, unknown>;
		if (a.id !== id) return;
		const answerId = typeof a.answerId === "string" && ANSWER_ID.test(a.answerId) ? a.answerId : "";
		const result = (accepted: boolean, reason?: Reason): void => bus.emit(`${PREFIX}:answer-result`, { version: 1, id, answerId, accepted, ...(reason ? { reason } : {}) });
		const verdict = by ? "closed" : check(a, digest, o.choices.length);
		if (typeof verdict === "string") return result(false, verdict);
		settle("remote", answerId, () => {
			winner = verdict;
			local.abort();
			result(true);
		});
	});
	o.signal?.addEventListener("abort", onAbort, { once: true });
	bus.emit(`${PREFIX}:pending`, { version: 1, id, toolCallId: o.toolCallId, digest, select: { title: o.title, choices: o.choices.map((choice) => ({ ...choice })), copy: o.copy } });
	if (o.signal?.aborted) settle("abort");
	// signal: for `select`, aborts on the tool signal or a remote answer. open: false when an answer arrived during the
	// `pending` emit, so the selector is not opened. finish: settles with the terminal's outcome (index, or undefined for
	// Escape) unless something else won, and returns the winning index. dispose: settles as an error, drops the listeners.
	return {
		signal: AbortSignal.any(o.signal ? [o.signal, local.signal] : [local.signal]),
		get open() { return by === undefined; },
		get remote() { return by === "remote"; },
		finish(picked: number | undefined): number | undefined {
			settle(picked === undefined ? "cancel" : "local");
			return by === "local" ? picked : winner;
		},
		dispose(): void {
			settle("error");
			off();
			o.signal?.removeEventListener("abort", onAbort);
		},
	};
}
