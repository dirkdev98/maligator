import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
	assertUsableMaligatorCacheRoot,
	maligatorCacheBaseDirectory,
	maligatorCacheDirectory,
} from "./cache-root.ts";
import { processIsAlive } from "./process-state.ts";

const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const LEASE_DIRECTORY = ".leases";
const PRUNE_LOCK = ".prune-lock";
const TEST_SUITE_SMOKE_FILE = "test-suite-smoke.json";
const GLOBAL_CLEAR_LOCK = ".clear-lock";
const LEASE_HEARTBEAT_MS = 30_000;
const LEASE_STALE_AFTER_MS = 10 * 60 * 1000;

interface CacheFamilyPolicy {
	path: string;
	keep: number;
	entryKind?: "children" | "grandchildren" | "self";
}

const CACHE_FAMILIES: Array<CacheFamilyPolicy> = [
	{ path: "build-frontend", keep: 64, entryKind: "grandchildren" },
	{ path: "build-fragments", keep: 64, entryKind: "grandchildren" },
	{ path: "dependency-fragments", keep: 64, entryKind: "grandchildren" },
	{ path: "test", keep: 64, entryKind: "grandchildren" },
	{ path: "frontend", keep: 512, entryKind: "grandchildren" },
	{ path: "compiler-wire", keep: 2 },
	{ path: "test262-artifacts", keep: 2 },
	// ProgramImages are grouped by compiler generation; retain one complete
	// generation rather than a few hundred arbitrary corpus entries.
	{ path: "test262-program-images", keep: 1 },
	{ path: "test262-wires", keep: 512, entryKind: "grandchildren" },
	{ path: "development-assets", keep: 64 },
	{ path: "toolchains", keep: 8 },
	{ path: "source-digests", keep: 8 },
	{ path: "zig", keep: 2 },
	{ path: "work", keep: 2, entryKind: "grandchildren" },
];

export interface CacheEntry {
	path: string;
	family: string;
	bytes: number;
	lastUsedMs: number;
}

export interface CacheStatus {
	root: string;
	totalBytes: number;
	managedBytes: number;
	entries: Array<CacheEntry>;
	activeLeases: number;
	activeCommands: Array<ActiveCacheCommand>;
}

export interface ActiveCacheCommand {
	pid: number;
	startedAt: number;
	command: string;
}

export interface CachePruneResult extends CacheStatus {
	removedBytes: number;
	removed: Array<CacheEntry>;
	dryRun: boolean;
}

export interface CacheClearResult extends CacheStatus {
	removedBytes: number;
	removed: Array<CacheEntry>;
}

export interface CachePruneOptions {
	cacheRoot?: string;
	maxBytes?: number;
	minAgeMs?: number;
	dryRun?: boolean;
	nowMs?: number;
}

export interface CacheLease {
	path?: string;
	release(): void;
}

function cacheRoot(override?: string): string {
	const root = maligatorCacheDirectory(override);
	assertUsableMaligatorCacheRoot(root);
	return root;
}

function globalClearLock(root: string): string | undefined {
	return path.resolve(root) === maligatorCacheDirectory()
		? path.join(maligatorCacheBaseDirectory(), GLOBAL_CLEAR_LOCK)
		: undefined;
}

function treeSize(target: string): number {
	let stats;
	try {
		stats = lstatSync(target);
	} catch {
		return 0;
	}
	if (!stats.isDirectory()) return stats.size;
	let total = 0;
	for (const child of readdirSync(target)) total += treeSize(path.join(target, child));
	return total;
}

function entry(target: string, family: string): CacheEntry {
	const stats = statSync(target);
	return {
		path: target,
		family,
		bytes: treeSize(target),
		lastUsedMs: Math.max(stats.atimeMs, stats.mtimeMs, stats.birthtimeMs),
	};
}

function visibleChildren(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true })
		.filter((item) => !item.name.startsWith("."))
		.map((item) => path.join(directory, item.name));
}

function familyEntries(root: string, policy: CacheFamilyPolicy): Array<CacheEntry> {
	const familyPath = path.join(root, policy.path);
	if (!existsSync(familyPath)) return [];
	if (policy.entryKind === "self") return [entry(familyPath, policy.path)];
	const children = visibleChildren(familyPath);
	if (policy.entryKind !== "grandchildren") {
		return children.map((target) => entry(target, policy.path));
	}
	return children.flatMap((directory) => {
		try {
			return visibleChildren(directory).map((target) => entry(target, policy.path));
		} catch {
			return [entry(directory, policy.path)];
		}
	});
}

function walkFiles(directory: string, visit: (file: string) => void): void {
	if (!existsSync(directory)) return;
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (item.name.startsWith(".")) continue;
		const target = path.join(directory, item.name);
		if (item.isDirectory()) walkFiles(target, visit);
		else if (item.isFile()) visit(target);
	}
}

function actionEntries(root: string): Array<CacheEntry> {
	const actionsRoot = path.join(root, "actions");
	const entries: Array<CacheEntry> = [];
	walkFiles(actionsRoot, (file) => {
		const relative = path.relative(actionsRoot, file).split(path.sep);
		entries.push(entry(file, `actions/${relative[0] ?? "unknown"}`));
	});
	return entries;
}

function blobEntries(root: string): Array<CacheEntry> {
	const entries: Array<CacheEntry> = [];
	walkFiles(path.join(root, "blobs", "sha256"), (file) => {
		entries.push(entry(file, "blobs"));
	});
	return entries;
}

type CacheLeaseRecord = ActiveCacheCommand;

function activeCacheCommands(
	root: string,
	cleanStale: boolean,
): Array<ActiveCacheCommand> {
	const directory = path.join(root, LEASE_DIRECTORY);
	if (!existsSync(directory)) return [];
	const active: Array<ActiveCacheCommand> = [];
	for (const name of readdirSync(directory)) {
		const leasePath = path.join(directory, name);
		try {
			const record = JSON.parse(readFileSync(leasePath, "utf8")) as CacheLeaseRecord;
			const heartbeatIsRecent =
				Date.now() - statSync(leasePath).mtimeMs <= LEASE_STALE_AFTER_MS;
			if (
				Number.isInteger(record.pid) &&
				typeof record.startedAt === "number" &&
				typeof record.command === "string" &&
				heartbeatIsRecent &&
				processIsAlive(record.pid)
			) {
				active.push(record);
			} else if (cleanStale) rmSync(leasePath, { force: true });
		} catch {
			if (cleanStale) rmSync(leasePath, { force: true });
		}
	}
	return active.sort((left, right) => left.startedAt - right.startedAt);
}

function managedEntries(root: string): Array<CacheEntry> {
	return [
		...CACHE_FAMILIES.flatMap((policy) => familyEntries(root, policy)),
		...actionEntries(root),
		...blobEntries(root),
	];
}

const MANAGED_ROOTS = new Set([
	...CACHE_FAMILIES.map((policy) => policy.path.split("/")[0]!),
	"actions",
	"blobs",
]);

function unmanagedBytes(root: string): number {
	if (!existsSync(root)) return 0;
	return readdirSync(root)
		.filter((name) => !MANAGED_ROOTS.has(name))
		.reduce((total, name) => total + treeSize(path.join(root, name)), 0);
}

export function inspectMaligatorCache(cacheRootOverride?: string): CacheStatus {
	const root = cacheRoot(cacheRootOverride);
	const entries = managedEntries(root);
	const activeCommands = activeCacheCommands(root, false);
	const managedBytes = entries.reduce((total, item) => total + item.bytes, 0);
	return {
		root,
		totalBytes: managedBytes + unmanagedBytes(root),
		managedBytes,
		entries,
		activeLeases: activeCommands.length,
		activeCommands,
	};
}

export function createCacheLease(
	command: string,
	cacheRootOverride?: string,
): CacheLease {
	const root = cacheRoot(cacheRootOverride);
	const directory = path.join(root, LEASE_DIRECTORY);
	const leasePath = path.join(directory, `${process.pid}-${randomUUID()}.json`);
	const lockPath = path.join(root, PRUNE_LOCK);
	const clearLockPath = globalClearLock(root);
	if (
		existsSync(lockPath) ||
		(clearLockPath !== undefined && existsSync(clearLockPath))
	) {
		throw new Error("Maligator cache maintenance is active; retry the command shortly");
	}
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			leasePath,
			`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), command } satisfies CacheLeaseRecord)}\n`,
			{ flag: "wx" },
		);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		process.stderr.write(
			`warning: unable to write Maligator cache lease in '${directory}'${code === undefined ? "" : ` (${code})`}; continuing without cache coordination. Set MALIGATOR_CACHE_DIR to a writable directory to restore cache coordination.\n`,
		);
		return { release() {} };
	}
	if (
		existsSync(lockPath) ||
		(clearLockPath !== undefined && existsSync(clearLockPath))
	) {
		rmSync(leasePath, { force: true });
		throw new Error(
			"Maligator cache maintenance started concurrently; retry the command",
		);
	}
	const heartbeat = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(leasePath, now, now);
		} catch {
			// A concurrent maintenance failure or external removal must not abort the command.
		}
	}, LEASE_HEARTBEAT_MS);
	const hostTimer = heartbeat as unknown as { unref?: () => void };
	hostTimer.unref?.();
	let released = false;
	return {
		path: leasePath,
		release() {
			if (released) return;
			released = true;
			clearInterval(heartbeat);
			rmSync(leasePath, { force: true });
		},
	};
}

function acquirePruneLock(root: string): string {
	const lockPath = path.join(root, PRUNE_LOCK);
	const clearLockPath = globalClearLock(root);
	if (clearLockPath !== undefined && existsSync(clearLockPath)) {
		throw new Error("Maligator cache clear is active");
	}
	mkdirSync(root, { recursive: true });
	try {
		mkdirSync(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Maligator cache maintenance is already active");
		}
		throw error;
	}
	if (clearLockPath !== undefined && existsSync(clearLockPath)) {
		rmSync(lockPath, { recursive: true, force: true });
		throw new Error("Maligator cache clear started concurrently");
	}
	return lockPath;
}

function actionBlobDigests(file: string): Array<string> {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf8")) as {
			schema?: unknown;
			outputs?: unknown;
		};
		if (manifest.schema !== 1 || !Array.isArray(manifest.outputs)) return [];
		return manifest.outputs.flatMap((output) => {
			if (typeof output !== "object" || output === null) return [];
			const digest = (output as { digest?: unknown }).digest;
			return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? [digest] : [];
		});
	} catch {
		return [];
	}
}

function blobDigest(root: string, file: string): string | undefined {
	const relative = path.relative(path.join(root, "blobs", "sha256"), file);
	const digest = relative.split(path.sep).join("");
	return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function retainedPerFamily(entries: Array<CacheEntry>, keep: number): Set<string> {
	return new Set(
		[...entries]
			.sort((left, right) => right.lastUsedMs - left.lastUsedMs)
			.slice(0, keep)
			.map((item) => item.path),
	);
}

export function pruneMaligatorCache(options: CachePruneOptions = {}): CachePruneResult {
	const root = cacheRoot(options.cacheRoot);
	const maxBytes = options.maxBytes ?? 5 * GIB;
	const minAgeMs = options.minAgeMs ?? DAY;
	const nowMs = options.nowMs ?? Date.now();
	const dryRun = options.dryRun ?? false;
	const lockPath = acquirePruneLock(root);
	try {
		const activeLeases = activeCacheCommands(root, true).length;
		if (activeLeases > 0) {
			throw new Error(
				`Refusing to prune while ${activeLeases} Maligator command${activeLeases === 1 ? " is" : "s are"} active`,
			);
		}
		const before = inspectMaligatorCache(root);
		let projectedBytes = before.totalBytes;
		const emergency = before.totalBytes > maxBytes * 2;
		const removed: Array<CacheEntry> = [];
		const removedPaths = new Set<string>();
		const remove = (candidate: CacheEntry) => {
			if (removedPaths.has(candidate.path)) return;
			removedPaths.add(candidate.path);
			removed.push(candidate);
			projectedBytes -= candidate.bytes;
			if (!dryRun) rmSync(candidate.path, { recursive: true, force: true });
		};
		const oldEnough = (candidate: CacheEntry) =>
			emergency || nowMs - candidate.lastUsedMs >= minAgeMs;

		const actions = before.entries.filter((candidate) =>
			candidate.family.startsWith("actions/"),
		);
		const blobs = before.entries.filter((candidate) => candidate.family === "blobs");
		const blobByDigest = new Map(
			blobs.flatMap((candidate) => {
				const digest = blobDigest(root, candidate.path);
				return digest === undefined ? [] : [[digest, candidate] as const];
			}),
		);
		const references = new Map<string, number>();
		for (const action of actions) {
			for (const digest of new Set(actionBlobDigests(action.path))) {
				references.set(digest, (references.get(digest) ?? 0) + 1);
			}
		}

		for (const blob of blobs
			.filter((candidate) => {
				const digest = blobDigest(root, candidate.path);
				return digest === undefined || !references.has(digest);
			})
			.filter(oldEnough)
			.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
			if (projectedBytes <= maxBytes) break;
			remove(blob);
		}

		const ordinary = before.entries.filter(
			(candidate) =>
				candidate.family !== "blobs" && !candidate.family.startsWith("actions/"),
		);
		for (const policy of CACHE_FAMILIES) {
			const family = ordinary.filter((candidate) => candidate.family === policy.path);
			const retained = retainedPerFamily(family, policy.keep);
			for (const candidate of family
				.filter((item) => !retained.has(item.path) && oldEnough(item))
				.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
				if (projectedBytes <= maxBytes) break;
				remove(candidate);
			}
		}

		const actionFamilies = new Set(actions.map((candidate) => candidate.family));
		for (const familyName of actionFamilies) {
			const family = actions.filter((candidate) => candidate.family === familyName);
			const retained = retainedPerFamily(family, 8);
			for (const candidate of family
				.filter((item) => !retained.has(item.path) && oldEnough(item))
				.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
				if (projectedBytes <= maxBytes) break;
				const digests = new Set(actionBlobDigests(candidate.path));
				remove(candidate);
				for (const digest of digests) {
					const remaining = (references.get(digest) ?? 1) - 1;
					references.set(digest, remaining);
					const blob = blobByDigest.get(digest);
					if (remaining === 0 && blob !== undefined) remove(blob);
				}
			}
		}

		if (!dryRun && removed.length > 0) {
			// The smoke marker means its native/runtime prerequisites are warm. Any
			// real artifact removal invalidates that premise, so the next gate must
			// use its cold-start fuse instead of reporting a false warm timeout.
			rmSync(path.join(root, TEST_SUITE_SMOKE_FILE), { force: true });
		}
		const after = {
			...before,
			totalBytes: Math.max(0, projectedBytes),
			managedBytes: Math.max(
				0,
				before.managedBytes - removed.reduce((total, item) => total + item.bytes, 0),
			),
			entries: before.entries.filter((item) => !removedPaths.has(item.path)),
		};
		return {
			...after,
			removedBytes: removed.reduce((total, item) => total + item.bytes, 0),
			removed,
			dryRun,
		};
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

/** Delete all layout generations without attempting to interpret their formats. */
export function clearAllMaligatorCaches(cacheBaseOverride?: string): CacheClearResult {
	const base = path.resolve(cacheBaseOverride ?? maligatorCacheBaseDirectory());
	assertUsableMaligatorCacheRoot(base);
	mkdirSync(base, { recursive: true });
	const lockPath = path.join(base, GLOBAL_CLEAR_LOCK);
	try {
		mkdirSync(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Maligator cache clear is already active");
		}
		throw error;
	}
	try {
		const children = readdirSync(base)
			.filter((name) => name !== GLOBAL_CLEAR_LOCK)
			.map((name) => path.join(base, name));
		let active = 0;
		for (const child of children) {
			if (!statSync(child).isDirectory()) continue;
			if (existsSync(path.join(child, PRUNE_LOCK))) {
				throw new Error("Maligator cache prune is active");
			}
			active += activeCacheCommands(child, true).length;
		}
		if (active > 0) {
			throw new Error(
				`Refusing to clear while ${active} Maligator command${active === 1 ? " is" : "s are"} active`,
			);
		}
		const removed = children.map((child) => entry(child, path.basename(child)));
		for (const child of children) rmSync(child, { recursive: true, force: true });
		return {
			root: base,
			totalBytes: 0,
			managedBytes: 0,
			entries: [],
			activeLeases: 0,
			activeCommands: [],
			removedBytes: removed.reduce((total, candidate) => total + candidate.bytes, 0),
			removed,
		};
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export function touchCacheEntry(target: string): void {
	try {
		const now = new Date();
		utimesSync(target, now, now);
	} catch {
		// Recency tracking is best-effort.
	}
}

export const DEFAULT_CACHE_MAX_BYTES = 5 * GIB;
export const DEFAULT_CACHE_MIN_AGE_MS = DAY;

export function formatCacheBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < GIB) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / GIB).toFixed(2)} GiB`;
}
