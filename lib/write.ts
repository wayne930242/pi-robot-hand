/**
 * Atomic file write for a placed secret.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyPlacement, type Placement, verifyPlaced } from "./placement.ts";

export interface WriteOutcome {
	bytes: number;
	created: boolean;
	mode: number;
	summary: string;
}

export const DEFAULT_NEW_FILE_MODE = 0o600;

export async function readExisting(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Replace `path` with `content` through a temp file and rename, so readers never see a partial file.
 */
async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
		await chmod(tmp, mode);
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

/**
 * Place `value` into `path`, write it atomically, and re-read it with `verify`.
 * When the check fails, the original content and mode are restored from memory (a new file is
 * removed) and the call throws; no backup file is ever written.
 * New files get `fileMode ?? 0600`; existing files keep their mode unless `fileMode` is given.
 */
export async function writeSecret(
	path: string,
	placement: Placement,
	value: string,
	fileMode: number | undefined,
	verify: (content: string, placement: Placement, value: string) => boolean = verifyPlaced,
): Promise<WriteOutcome> {
	const existing = await readExisting(path);
	const { content, summary } = applyPlacement(existing, placement, value);
	const created = existing === undefined;
	const originalMode = created ? undefined : (await stat(path)).mode & 0o777;
	const mode = fileMode ?? originalMode ?? DEFAULT_NEW_FILE_MODE;

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await atomicWrite(path, content, mode);
	if (!verify(await readFile(path, "utf8"), placement, value)) {
		if (existing === undefined || originalMode === undefined) await unlink(path);
		else await atomicWrite(path, existing, originalMode);
		throw new Error(`verification failed after writing; ${created ? "removed the new file" : "restored the original content"}.`);
	}
	return { bytes: Buffer.byteLength(content), created, mode, summary };
}

/**
 * Parse an octal permission string such as "600".
 */
export function parseFileMode(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^0?[0-7]{3}$/.test(raw)) throw new Error(`Invalid file mode "${raw}". Use octal like "600".`);
	return Number.parseInt(raw, 8);
}
