import { spawnSync } from "node:child_process";
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
	cacheBudget,
	clearAllMaligatorCaches,
	createCacheLease,
	estimateCacheBytes,
	inspectMaligatorCache,
	maintainMaligatorCache,
	pruneMaligatorCache,
	readCacheUsage,
	recordCacheGrowth,
	setCacheMaintenanceCommand,
	startCacheMaintenanceIfDue,
} from "../src/cache-management.ts";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { CommandProgress } from "../src/command-progress.ts";

const DAY = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
// Fixture ages must follow the real creation time, which utimes cannot backdate on Linux.
const pruneNowMs = Date.now() + 30 * DAY;

function cacheRoot(): string {
	return mkdtempSync(path.join(os.tmpdir(), "mal-cache-management-"));
}

/** A user cache root that automatic maintenance treats as the default one. */
function defaultCacheRoot(): { root: string; environment: NodeJS.ProcessEnv } {
	const environment = { MALIGATOR_CACHE_DIR: cacheRoot() };
	const root = maligatorCacheDirectory(undefined, environment);
	mkdirSync(root, { recursive: true });
	return { root, environment };
}

function finishedProcessId(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid;
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

	it("previews without deleting", () => {
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
	});

	it("prunes beside a running command but keeps what it may still be using", () => {
		const root = cacheRoot();
		const old = artifact(root, "thinlto/toolchain", "old", 100, 10);
		const recent = artifact(root, "thinlto/toolchain", "in-use", 100, 10 / (24 * 60));
		const lease = createCacheLease("dev", root);
		try {
			const result = pruneMaligatorCache({
				cacheRoot: root,
				maxBytes: 1,
				minAgeMs: 0,
				nowMs: pruneNowMs,
			});
			expect(result.removed.map((entry) => entry.path)).toEqual([old]);
			expect(existsSync(recent)).toBe(true);
		} finally {
			lease.release();
		}
	});

	it("keeps a live process's scratch and collects a finished one's within budget", () => {
		const root = cacheRoot();
		const live = artifact(root, "work/local-runner", `${process.pid}-live`, 100, 10);
		const dead = artifact(
			root,
			"work/local-runner",
			`${finishedProcessId()}-dead`,
			100,
			10,
		);

		const result = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 10_000,
			minAgeMs: DAY,
			nowMs: pruneNowMs,
		});

		expect(result.removed.map((entry) => entry.path)).toEqual([dead]);
		expect(existsSync(live)).toBe(true);
	});

	it("manages the linker's ThinLTO cache files", () => {
		const root = cacheRoot();
		const old = artifact(root, "thinlto/toolchain-a", "llvmcache-old", 100, 10);
		const recent = artifact(root, "thinlto/toolchain-b", "llvmcache-recent", 100, 0);

		const result = pruneMaligatorCache({
			cacheRoot: root,
			maxBytes: 150,
			minAgeMs: DAY,
			nowMs: pruneNowMs,
		});

		expect(result.removed.map((entry) => entry.path)).toEqual([old]);
		expect(existsSync(recent)).toBe(true);
	});

	it("lets a volume with room to spare hold more before pruning", () => {
		expect(cacheBudget(500 * GIB, {})).toEqual({
			maxBytes: 100 * GIB,
			targetBytes: 40 * GIB,
		});
		expect(cacheBudget(150 * GIB, {})).toEqual({
			maxBytes: 20 * GIB,
			targetBytes: 15 * GIB,
		});
		expect(cacheBudget(500 * GIB, { MALIGATOR_CACHE_MAX_GB: "8" })).toEqual({
			maxBytes: 8 * GIB,
			targetBytes: 6 * GIB,
		});
		expect(() => cacheBudget(500 * GIB, { MALIGATOR_CACHE_MAX_GB: "lots" })).toThrow(
			"MALIGATOR_CACHE_MAX_GB",
		);
	});

	it("estimates growth since the last measurement without scanning", () => {
		const root = cacheRoot();
		artifact(root, "compiler-wire", "measured", 100, 0);
		expect(estimateCacheBytes(root)).toBeUndefined();

		maintainMaligatorCache({ cacheRoot: root, freeBytes: 500 * GIB, environment: {} });
		recordCacheGrowth(root, 40);
		recordCacheGrowth(root, 2);

		expect(readCacheUsage(root)?.bytes).toBe(100);
		expect(estimateCacheBytes(root)).toBe(142);
		maintainMaligatorCache({ cacheRoot: root, freeBytes: 500 * GIB, environment: {} });
		expect(estimateCacheBytes(root)).toBe(100);
	});

	it("maintains an over-budget cache back to its target", () => {
		const root = cacheRoot();
		const old = artifact(root, "thinlto/toolchain", "old", 1000, 10);
		const recent = artifact(root, "thinlto/toolchain", "recent", 1000, 0);

		const result = maintainMaligatorCache({
			cacheRoot: root,
			nowMs: pruneNowMs,
			freeBytes: 500 * GIB,
			environment: { MALIGATOR_CACHE_MAX_GB: String(1500 / GIB) },
		});

		expect(result?.pruned?.removed.map((entry) => entry.path)).toEqual([old]);
		expect(existsSync(recent)).toBe(true);
		expect(readCacheUsage(root)).toMatchObject({ bytes: 1000, removedBytes: 1000 });
	});

	it("leaves a cache within budget untouched", () => {
		const root = cacheRoot();
		const old = artifact(root, "compiler-wire", "old", 1000, 10);

		const result = maintainMaligatorCache({
			cacheRoot: root,
			nowMs: pruneNowMs,
			freeBytes: 500 * GIB,
			environment: {},
		});

		expect(result?.pruned).toBeUndefined();
		expect(existsSync(old)).toBe(true);
	});

	it("starts background maintenance only when it is due", () => {
		setCacheMaintenanceCommand([process.execPath, "-e", ""]);
		const { root, environment } = defaultCacheRoot();
		const plenty = { freeBytes: 500 * GIB, environment };

		expect(startCacheMaintenanceIfDue(root, plenty)).toBe(true);
		expect(startCacheMaintenanceIfDue(root, plenty)).toBe(false);

		rmSync(path.join(root, ".maintenance-started"));
		maintainMaligatorCache({ cacheRoot: root, ...plenty });
		expect(startCacheMaintenanceIfDue(root, plenty)).toBe(false);
		recordCacheGrowth(root, 101 * GIB);
		expect(startCacheMaintenanceIfDue(root, plenty)).toBe(true);
	});

	it("starts maintenance at once on a nearly full volume", () => {
		setCacheMaintenanceCommand([process.execPath, "-e", ""]);
		const { root, environment } = defaultCacheRoot();
		maintainMaligatorCache({ cacheRoot: root, freeBytes: 500 * GIB, environment });

		expect(
			startCacheMaintenanceIfDue(root, {
				lowDiskOnly: true,
				freeBytes: 50 * GIB,
				environment,
			}),
		).toBe(false);
		expect(
			startCacheMaintenanceIfDue(root, {
				lowDiskOnly: true,
				freeBytes: GIB,
				environment,
			}),
		).toBe(true);
	});

	it("leaves CI runners, opted-out users and other cache roots alone", () => {
		setCacheMaintenanceCommand([process.execPath, "-e", ""]);
		const { root, environment } = defaultCacheRoot();
		for (const override of [{ CI: "true" }, { MALIGATOR_CACHE_MAINTENANCE: "off" }])
			expect(
				startCacheMaintenanceIfDue(root, {
					freeBytes: GIB,
					environment: { ...environment, ...override },
				}),
			).toBe(false);
		expect(startCacheMaintenanceIfDue(cacheRoot(), { freeBytes: GIB, environment })).toBe(
			false,
		);
	});

	it("lets commands start while maintenance holds the cache", () => {
		const root = cacheRoot();
		mkdirSync(path.join(root, ".prune-lock"));

		const lease = createCacheLease("build", root);

		expect(lease.path).toBeDefined();
		expect(
			maintainMaligatorCache({ cacheRoot: root, freeBytes: 500 * GIB }),
		).toBeUndefined();
		lease.release();
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

	it("prunes compiler work before older Rust work", () => {
		const root = cacheRoot();
		try {
			const rust = [
				artifact(root, "work/rust", "old-rust", 100, 20),
				artifact(root, "work/rust-tests", "rust-tests", 100, 2),
				artifact(root, "work/wasm-rust", "wasm-rust", 100, 1),
			];
			const compiler = [
				artifact(root, "work/selfhost-frontend", "old-compiler", 100, 10),
				artifact(root, "work/selfhost-frontend", "recent-a", 100, 1),
				artifact(root, "work/selfhost-frontend", "recent-b", 100, 0),
			];
			const result = pruneMaligatorCache({
				cacheRoot: root,
				maxBytes: 500,
				minAgeMs: 0,
				nowMs: pruneNowMs,
			});
			expect(result.removed.map((entry) => entry.path)).toEqual([compiler[0]]);
			for (const target of rust) expect(existsSync(target)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prunes compiler actions before older Rust library actions", () => {
		const root = cacheRoot();
		try {
			const actions = (family: string) =>
				Array.from({ length: 9 }, (_, index) => {
					const target = path.join(root, "actions", family, `${index}.json`);
					mkdirSync(path.dirname(target), { recursive: true });
					writeFileSync(target, "x".repeat(100));
					const age = index === 0 ? (family === "rust-library" ? 20 : 10) : 1;
					const usedAt = new Date(pruneNowMs - age * DAY);
					utimesSync(target, usedAt, usedAt);
					return target;
				});
			const rust = actions("rust-library");
			const compiler = actions("wasm-object");
			const result = pruneMaligatorCache({
				cacheRoot: root,
				maxBytes: 1700,
				minAgeMs: 0,
				nowMs: pruneNowMs,
			});
			expect(result.removed.map((entry) => entry.path)).toEqual([compiler[0]]);
			for (const target of rust) expect(existsSync(target)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
