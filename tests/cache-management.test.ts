import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	clearAllMaligatorCaches,
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
		const smokeStamp = path.join(root, "test-suite-smoke.json");
		mkdirSync(path.dirname(smokeStamp), { recursive: true });
		writeFileSync(smokeStamp, "{}\n");
		const oldest = artifact(root, "compiler-wire", "oldest", 100, 10);
		const old = artifact(root, "compiler-wire", "old", 100, 9);
		const recent = Array.from({ length: 6 }, (_, index) =>
			artifact(root, "compiler-wire", `recent-${index}`, 100, 0),
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
		const smokeStamp = path.join(root, "test-suite-smoke.json");
		mkdirSync(path.dirname(smokeStamp), { recursive: true });
		writeFileSync(smokeStamp, "{}\n");
		const old = artifact(root, "compiler-wire", "old", 100, 10);
		for (let index = 0; index < 6; index++) {
			artifact(root, "compiler-wire", `retained-${index}`, 100, 9 - index);
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

	it("warns and continues when the cache lease cannot be written", () => {
		const root = cacheRoot();
		writeFileSync(path.join(root, ".leases"), "not a directory\n");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const lease = createCacheLease("build", root);
			expect(lease.path).toBeUndefined();
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining("continuing without cache coordination"),
			);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("MALIGATOR_CACHE_DIR"));
			lease.release();
		} finally {
			stderr.mockRestore();
		}
	});

	it("refuses to lease or inspect a cache root that is a file", () => {
		const root = path.join(cacheRoot(), "cache-file");
		writeFileSync(root, "not a directory\n");

		expect(() => createCacheLease("build", root)).toThrow("is a file, not a directory");
		expect(() => inspectMaligatorCache(root)).toThrow("is a file, not a directory");
	});

	it("clears every layout generation without retaining old machinery", () => {
		const base = cacheRoot();
		const firstRoot = path.join(base, "v1");
		const first = artifact(firstRoot, "runtime", "first", 100, 10);
		const second = artifact(path.join(base, "v2"), "future", "second", 200, 10);
		const lease = createCacheLease("old-version", firstRoot);
		expect(() => clearAllMaligatorCaches(base)).toThrow(
			"Refusing to clear while 1 Maligator command is active",
		);
		lease.release();

		const result = clearAllMaligatorCaches(base);

		expect(result.root).toBe(base);
		expect(result.removedBytes).toBeGreaterThanOrEqual(300);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(existsSync(base)).toBe(true);
	});
});
