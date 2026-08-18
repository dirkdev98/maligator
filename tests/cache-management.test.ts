import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCacheLease,
	inspectMaligatorCache,
	pruneMaligatorCache,
} from "../src/cache-management.ts";

function cacheRoot(): string {
	return mkdtempSync(path.join(os.tmpdir(), "mal-cache-management-"));
}

function artifact(
	root: string,
	family: string,
	name: string,
	bytes: number,
	ageDays: number,
) {
	const directory = path.join(root, family, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "artifact"), Buffer.alloc(bytes));
	const usedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
	utimesSync(directory, usedAt, usedAt);
	return directory;
}

describe("Maligator cache management", () => {
	it("retains recent entries and prunes old excess entries to a size target", () => {
		const root = cacheRoot();
		const smokeStamp = path.join(root, "mal-cache/test-suite-smoke.json");
		mkdirSync(path.dirname(smokeStamp), { recursive: true });
		writeFileSync(smokeStamp, "{}\n");
		const oldest = artifact(root, "mal-cache/runtime", "oldest", 100, 10);
		const old = artifact(root, "mal-cache/runtime", "old", 100, 9);
		const recent = Array.from({ length: 6 }, (_, index) =>
			artifact(root, "mal-cache/runtime", `recent-${index}`, 100, 0),
		);

		const result = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 650,
			minAgeMs: 24 * 60 * 60 * 1000,
		});

		expect(result.removed.map((entry) => entry.path)).toContain(oldest);
		expect(result.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(smokeStamp)).toBe(false);
		for (const directory of recent) expect(existsSync(directory)).toBe(true);
	});

	it("previews without deleting and refuses to race an active command", () => {
		const root = cacheRoot();
		const smokeStamp = path.join(root, "mal-cache/test-suite-smoke.json");
		mkdirSync(path.dirname(smokeStamp), { recursive: true });
		writeFileSync(smokeStamp, "{}\n");
		const old = artifact(root, "mal-cache/runtime", "old", 100, 10);
		for (let index = 0; index < 6; index++) {
			artifact(root, "mal-cache/runtime", `retained-${index}`, 100, 9 - index);
		}
		const preview = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 1,
			minAgeMs: 0,
			dryRun: true,
		});
		expect(preview.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(old)).toBe(true);
		expect(existsSync(smokeStamp)).toBe(true);

		const lease = createCacheLease("test", root);
		try {
			expect(() =>
				pruneMaligatorCache({ cacheRoot: root, maxBytes: 1, minAgeMs: 0 }),
			).toThrow("Refusing to prune while 1 Maligator command is active");
		} finally {
			lease.release();
		}
		expect(inspectMaligatorCache(root).activeLeases).toBe(0);
	});
});
