import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	clearAllMaligatorCaches,
	createCacheLease,
	inspectMaligatorCache,
	pruneMaligatorCache,
} from "../src/cache-management.ts";
import { CommandProgress } from "../src/command-progress.ts";

const DAY = 24 * 60 * 60 * 1000;
// Fixture ages must follow the real creation time, which utimes cannot backdate on Linux.
const pruneNowMs = Date.now() + 30 * DAY;

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
	const usedAt = new Date(pruneNowMs - ageDays * DAY);
	utimesSync(directory, usedAt, usedAt);
	return directory;
}

describe("Maligator cache management", () => {
	it("accounts and prunes complete Core entries with separately loaded variants", () => {
		const root = cacheRoot();
		try {
			const entries = Array.from({ length: 129 }, (_, index) => {
				const directory = artifact(root, "core-modules", `module-${index}`, 10, 10);
				writeFileSync(path.join(directory, "canonical.json"), Buffer.alloc(20));
				writeFileSync(path.join(directory, "optimized.json"), Buffer.alloc(30));
				const usedAt = new Date(pruneNowMs - (index === 0 ? 20 : 10) * DAY);
				utimesSync(directory, usedAt, usedAt);
				return directory;
			});
			expect(inspectMaligatorCache(root).managedBytes).toBe(129 * 60);
			const result = pruneMaligatorCache({
				cacheRoot: root,
				maxBytes: 1,
				minAgeMs: 0,
				nowMs: pruneNowMs,
			});
			expect(result.removed.map((entry) => entry.path)).toEqual([entries[0]]);
			for (const directory of entries.slice(1)) {
				expect(existsSync(path.join(directory, "canonical.json"))).toBe(true);
				expect(existsSync(path.join(directory, "optimized.json"))).toBe(true);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
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
			minAgeMs: DAY,
			nowMs: pruneNowMs,
		});

		expect(result.removed.map((entry) => entry.path)).toContain(oldest);
		expect(result.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(smokeStamp)).toBe(false);
		for (const directory of recent) expect(existsSync(directory)).toBe(true);
	});

	it("counts managed and unmanaged cache roots without double-counting", () => {
		const root = cacheRoot();
		artifact(root, "compiler-wire", "managed", 100, 0);
		artifact(root, "file-digests", "unmanaged", 40, 0);

		const status = inspectMaligatorCache(root);

		expect(status.managedBytes).toBe(100);
		expect(status.totalBytes).toBe(140);
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
			nowMs: pruneNowMs,
			dryRun: true,
		});
		expect(preview.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(old)).toBe(true);
		expect(existsSync(smokeStamp)).toBe(true);

		const lease = createCacheLease("test", root);
		try {
			expect(() =>
				pruneMaligatorCache({
					cacheRoot: root,
					maxBytes: 1,
					minAgeMs: 0,
					nowMs: pruneNowMs,
				}),
			).toThrow("Refusing to prune while 1 Maligator command is active");
		} finally {
			lease.release();
		}
		expect(inspectMaligatorCache(root).activeLeases).toBe(0);
	});

	it("retains a complete Test262 ProgramImage compiler generation", () => {
		const root = cacheRoot();
		const old = artifact(root, "test262-program-images", "old-compiler", 100, 10);
		const current = artifact(root, "test262-program-images", "current-compiler", 100, 0);
		mkdirSync(path.join(current, "aa", "image-a"), { recursive: true });
		writeFileSync(path.join(current, "aa", "image-a", "program.malc"), "image");

		const result = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 1,
			minAgeMs: 0,
			nowMs: pruneNowMs,
		});

		expect(result.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(path.join(current, "aa", "image-a", "program.malc"))).toBe(true);
	});

	it("retains the two most recently used shared Test262 corpus revisions", () => {
		const root = cacheRoot();
		const old = artifact(root, "test262-corpora", "old-revision", 100, 10);
		const recent = [
			artifact(root, "test262-corpora", "previous-revision", 100, 1),
			artifact(root, "test262-corpora", "current-revision", 100, 0),
		];
		try {
			const result = pruneMaligatorCache({
				cacheRoot: root,
				maxBytes: 1,
				minAgeMs: 0,
				nowMs: pruneNowMs,
			});
			expect(result.removed.map((entry) => entry.path)).toEqual([old]);
			for (const directory of recent) expect(existsSync(directory)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prunes Rust target families independently", () => {
		const root = cacheRoot();
		const old = artifact(root, "work/rust", "old-target", 100, 10);
		const recent = [
			artifact(root, "work/rust", "recent-a", 100, 1),
			artifact(root, "work/rust", "recent-b", 100, 0),
		];

		const result = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 1,
			minAgeMs: 0,
			nowMs: pruneNowMs,
		});

		expect(result.removed.map((entry) => entry.path)).toContain(old);
		expect(existsSync(old)).toBe(false);
		for (const directory of recent) expect(existsSync(directory)).toBe(true);
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

	it("releases progress leases on hosts with numeric interval handles", () => {
		const root = cacheRoot();
		const setIntervalSpy = vi
			.spyOn(globalThis, "setInterval")
			.mockReturnValue(1 as never);
		const clearIntervalSpy = vi
			.spyOn(globalThis, "clearInterval")
			.mockImplementation(() => {});
		try {
			const progress = new CommandProgress("test", {
				cacheRoot: root,
				quiet: true,
			});
			expect(inspectMaligatorCache(root).activeLeases).toBe(1);
			progress.complete();
			expect(inspectMaligatorCache(root).activeLeases).toBe(0);
			expect(clearIntervalSpy).toHaveBeenCalledWith(1);
		} finally {
			setIntervalSpy.mockRestore();
			clearIntervalSpy.mockRestore();
		}
	});

	it("releases progress leases when a command completes or fails", () => {
		for (const outcome of ["complete", "failed"] as const) {
			const root = cacheRoot();
			const progress = new CommandProgress("test", {
				cacheRoot: root,
				quiet: true,
			});
			expect(inspectMaligatorCache(root).activeLeases).toBe(1);
			progress[outcome]();
			expect(inspectMaligatorCache(root).activeLeases).toBe(0);
		}
	});

	it("rejects a reused live pid after its lease heartbeat expires", () => {
		const root = cacheRoot();
		const lease = createCacheLease("build", root);
		if (lease.path === undefined) throw new Error("expected cache lease path");
		try {
			const stale = new Date(Date.now() - 11 * 60 * 1000);
			utimesSync(lease.path, stale, stale);
			expect(inspectMaligatorCache(root).activeLeases).toBe(0);
		} finally {
			lease.release();
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
