/**
 * pi-secret-drop is now part of pi-robot-hand. When the old package is still configured, both would
 * register `secret_drop` and pi refuses to start, so pi-robot-hand steps aside and asks the user to
 * remove the old package.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LegacyInstall {
	source: string;
	/** Settings file that lists the package. */
	settings: string;
	/** True for a project-local install (`pi remove -l`). */
	local: boolean;
}

function packageSources(file: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
		if (!Array.isArray(parsed.packages)) return [];
		return parsed.packages.flatMap((entry: unknown) => {
			if (typeof entry === "string") return [entry];
			const source = (entry as { source?: unknown } | null)?.source;
			return typeof source === "string" ? [source] : [];
		});
	} catch {
		return [];
	}
}

/** The separately configured pi-secret-drop, project settings first, if any. */
export function findLegacySecretDrop(agentDir: string, cwd: string): LegacyInstall | undefined {
	for (const [settings, local] of [
		[join(cwd, ".pi", "settings.json"), true],
		[join(agentDir, "settings.json"), false],
	] as const) {
		const source = packageSources(settings).find((entry) => /(^|[/:])pi-secret-drop(@|$|\.git|#)/.test(entry));
		if (source) return { source, settings, local };
	}
	return undefined;
}

export function legacyNotice(legacy: LegacyInstall): string {
	const remove = `pi remove ${legacy.local ? "-l " : ""}${legacy.source}`;
	return `pi-robot-hand now includes secret_drop, so the separate pi-secret-drop (${legacy.settings}) is no longer needed. Remove it with \`${remove}\`, then /reload. Until then secret_drop comes from pi-secret-drop.`;
}
