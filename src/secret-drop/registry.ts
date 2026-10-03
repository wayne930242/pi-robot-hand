/**
 * Durable list of files that hold secrets. It stores locations only, never values.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Placement } from "../../lib/placement.ts";

export interface RegistryEntry {
	/** Canonical absolute path. */
	path: string;
	placement: Placement;
	label: string;
	updatedAt: string;
}

interface RegistryFile {
	version: 1;
	entries: RegistryEntry[];
}

function sameSlot(a: RegistryEntry, b: RegistryEntry): boolean {
	if (a.path !== b.path || a.placement.mode !== b.placement.mode) return false;
	if (a.placement.mode === "env" && b.placement.mode === "env") return a.placement.key === b.placement.key;
	if (a.placement.mode === "regex" && b.placement.mode === "regex") {
		return a.placement.pattern === b.placement.pattern && a.placement.flags === b.placement.flags;
	}
	return true;
}

export class Registry {
	private entries: RegistryEntry[] = [];

	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.entries = [];
				return;
			}
			throw error;
		}
		const parsed = JSON.parse(raw) as RegistryFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
			throw new Error(`Unrecognized secret-drop registry format in ${this.file}`);
		}
		this.entries = parsed.entries;
	}

	list(): readonly RegistryEntry[] {
		return this.entries;
	}

	paths(): Set<string> {
		return new Set(this.entries.map((entry) => entry.path));
	}

	async upsert(entry: RegistryEntry): Promise<void> {
		this.entries = [...this.entries.filter((existing) => !sameSlot(existing, entry)), entry];
		await this.save();
	}

	/** Remove every entry for `path`. Returns how many were removed. */
	async forget(path: string): Promise<number> {
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.path !== path);
		const removed = before - this.entries.length;
		if (removed > 0) await this.save();
		return removed;
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const body: RegistryFile = { version: 1, entries: this.entries };
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, this.file);
		await chmod(this.file, 0o600);
	}
}
