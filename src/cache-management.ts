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

const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const LEASE_DIRECTORY = ".leases";
const PRUNE_LOCK = ".prune-lock";
const MAINTENANCE_FILE = ".maintenance.json";

interface CacheFamilyPolicy {
	path: string;
	keep: number;
	entryKind?: "children" | "grandchildren" | "self";
}

const CACHE_FAMILIES: Array<CacheFamilyPolicy> = [
	{ path: "mal-cache/linked-binaries", keep: 24 },
	{ path: "mal-cache/rust", keep: 3 },
	{ path: "mal-cache/runtime", keep: 6 },
	{ path: "mal-cache/generated-c", keep: 64 },
	{ path: "mal-cache/compiler-wire", keep: 2 },
	{ path: "mal-cache/test262-artifacts", keep: 2 },
	{ path: "mal-cache/test262-wires", keep: 512, entryKind: "grandchildren" },
	{ path: "mal-build", keep: 2 },
	{ path: "wpt/build", keep: 0, entryKind: "self" },
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
}

export interface CachePruneResult extends CacheStatus {
	removedBytes: number;
	removed: Array<CacheEntry>;
	dryRun: boolean;
}

export interface CachePruneOptions {
	cacheRoot?: string;
	maxBytes?: number;
	minAgeMs?: number;
	dryRun?: boolean;
	nowMs?: number;
}

export interface CacheLease {
	path: string;
	release(): void;
}

function cacheRoot(override?: string): string {
	return path.resolve(override ?? ".cache");
}

function malCacheRoot(root: string): string {
	return path.join(root, "mal-cache");
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
	for (const entry of readdirSync(target)) total += treeSize(path.join(target, entry));
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

function familyEntries(root: string, policy: CacheFamilyPolicy): Array<CacheEntry> {
	const familyPath = path.join(root, policy.path);
	if (!existsSync(familyPath)) return [];
	if (policy.entryKind === "self") return [entry(familyPath, policy.path)];
	const children = readdirSync(familyPath, { withFileTypes: true })
		.filter((item) => !item.name.startsWith("."))
		.map((item) => path.join(familyPath, item.name));
	if (policy.entryKind !== "grandchildren") {
		return children.map((target) => entry(target, policy.path));
	}
	return children.flatMap((directory) =>
		readdirSync(directory, { withFileTypes: true })
			.filter((item) => !item.name.startsWith("."))
			.map((item) => entry(path.join(directory, item.name), policy.path)),
	);
}

interface CacheLeaseRecord {
	pid: number;
	startedAt: number;
	command: string;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function activeLeaseCount(root: string, cleanStale: boolean): number {
	const directory = path.join(malCacheRoot(root), LEASE_DIRECTORY);
	if (!existsSync(directory)) return 0;
	let active = 0;
	for (const name of readdirSync(directory)) {
		const leasePath = path.join(directory, name);
		try {
			const record = JSON.parse(readFileSync(leasePath, "utf8")) as CacheLeaseRecord;
			if (Number.isInteger(record.pid) && processIsAlive(record.pid)) {
				active++;
			} else if (cleanStale) {
				rmSync(leasePath, { force: true });
			}
		} catch {
			if (cleanStale) rmSync(leasePath, { force: true });
		}
	}
	return active;
}

export function inspectMaligatorCache(cacheRootOverride?: string): CacheStatus {
	const root = cacheRoot(cacheRootOverride);
	const entries = CACHE_FAMILIES.flatMap((policy) => familyEntries(root, policy));
	return {
		root,
		totalBytes: treeSize(root),
		managedBytes: entries.reduce((total, item) => total + item.bytes, 0),
		entries,
		activeLeases: activeLeaseCount(root, false),
	};
}

export function createCacheLease(
	command: string,
	cacheRootOverride?: string,
): CacheLease {
	const root = cacheRoot(cacheRootOverride);
	const directory = path.join(malCacheRoot(root), LEASE_DIRECTORY);
	mkdirSync(directory, { recursive: true });
	const leasePath = path.join(directory, `${process.pid}-${randomUUID()}.json`);
	const lockPath = path.join(malCacheRoot(root), PRUNE_LOCK);
	if (existsSync(lockPath)) {
		throw new Error("Maligator cache maintenance is active; retry the command shortly");
	}
	writeFileSync(
		leasePath,
		`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), command } satisfies CacheLeaseRecord)}\n`,
		{ flag: "wx" },
	);
	if (existsSync(lockPath)) {
		rmSync(leasePath, { force: true });
		throw new Error(
			"Maligator cache maintenance started concurrently; retry the command",
		);
	}
	let released = false;
	return {
		path: leasePath,
		release() {
			if (released) return;
			released = true;
			rmSync(leasePath, { force: true });
		},
	};
}

function acquirePruneLock(root: string): string {
	const lockPath = path.join(malCacheRoot(root), PRUNE_LOCK);
	mkdirSync(malCacheRoot(root), { recursive: true });
	try {
		mkdirSync(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Maligator cache maintenance is already active");
		}
		throw error;
	}
	return lockPath;
}

export function pruneMaligatorCache(options: CachePruneOptions = {}): CachePruneResult {
	const root = cacheRoot(options.cacheRoot);
	const maxBytes = options.maxBytes ?? 5 * GIB;
	const minAgeMs = options.minAgeMs ?? DAY;
	const nowMs = options.nowMs ?? Date.now();
	const dryRun = options.dryRun ?? false;
	const lockPath = acquirePruneLock(root);
	try {
		const activeLeases = activeLeaseCount(root, true);
		if (activeLeases > 0) {
			throw new Error(
				`Refusing to prune while ${activeLeases} Maligator command${activeLeases === 1 ? " is" : "s are"} active`,
			);
		}
		const before = inspectMaligatorCache(root);
		let projectedBytes = before.totalBytes;
		const emergency = before.totalBytes > maxBytes * 2;
		const eligible: Array<CacheEntry> = [];
		for (const policy of CACHE_FAMILIES) {
			const entries = before.entries
				.filter((item) => item.family === policy.path)
				.sort((left, right) => right.lastUsedMs - left.lastUsedMs);
			eligible.push(
				...entries
					.slice(policy.keep)
					.filter((item) => emergency || nowMs - item.lastUsedMs >= minAgeMs),
			);
		}
		eligible.sort((left, right) => left.lastUsedMs - right.lastUsedMs);
		const removed: Array<CacheEntry> = [];
		for (const candidate of eligible) {
			if (projectedBytes <= maxBytes) break;
			removed.push(candidate);
			projectedBytes -= candidate.bytes;
			if (!dryRun) rmSync(candidate.path, { recursive: true, force: true });
		}
		const after = dryRun
			? { ...before, totalBytes: projectedBytes }
			: inspectMaligatorCache(root);
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

export function maybeMaintainMaligatorCache(
	cacheRootOverride?: string,
): CachePruneResult | undefined {
	const root = cacheRoot(cacheRootOverride);
	const statePath = path.join(malCacheRoot(root), MAINTENANCE_FILE);
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as { checkedAt?: unknown };
		if (typeof state.checkedAt === "number" && Date.now() - state.checkedAt < DAY) {
			return undefined;
		}
	} catch {
		// First run or damaged state: perform a conservative maintenance pass.
	}
	const result = pruneMaligatorCache({
		cacheRoot: root,
		maxBytes: 8 * GIB,
		minAgeMs: 7 * DAY,
	});
	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ checkedAt: Date.now() })}\n`);
	return result;
}

export function touchCacheEntry(target: string): void {
	try {
		const now = new Date();
		utimesSync(target, now, now);
	} catch {
		// Recency tracking is best-effort and never invalidates a usable cache hit.
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
