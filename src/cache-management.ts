import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import {
	assertUsableMaligatorCacheRoot,
	maligatorCacheBaseDirectory,
	maligatorCacheDirectory,
} from "./cache-root.ts";
import { processIsAlive } from "./process-state.ts";

const GIB = 1024 ** 3;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE_DIRECTORY = ".leases";
const PRUNE_LOCK = ".prune-lock";
const TEST_SUITE_SMOKE_FILE = "test-suite-smoke.json";
const GLOBAL_CLEAR_LOCK = ".clear-lock";
const LEASE_HEARTBEAT_MS = 30_000;
const LEASE_STALE_AFTER_MS = 10 * 60 * 1000;
const RUST_WORK_FAMILIES = new Set(["rust", "rust-tests", "wasm-rust"]);
const RUST_ACTION_FAMILIES = new Set(["actions/rust-library", "actions/wasm-rust"]);
const USAGE_FILE = ".usage.json";
const USAGE_JOURNAL = ".usage-journal";
const MAINTENANCE_MARKER = ".maintenance-started";
/** Entries used this recently may belong to a command that is still running. */
const PROTECTION_MS = HOUR;
/** Below this much free space maintenance starts at once and protects less. */
const DISK_RESERVE_BYTES = 10 * GIB;
const LOW_DISK_PROTECTION_MS = 10 * MINUTE;
const MAINTENANCE_INTERVAL_MS = DAY;
const MAINTENANCE_RETRY_MS = 10 * MINUTE;
const ROOMY_VOLUME_BYTES = 200 * GIB;

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
	{ path: "test262-corpora", keep: 2 },
	{ path: "test262-artifacts", keep: 2 },
	// ProgramImages are grouped by compiler generation; retain one complete
	// generation rather than a few hundred arbitrary corpus entries.
	{ path: "test262-program-images", keep: 1 },
	{ path: "test262-wires", keep: 512, entryKind: "grandchildren" },
	{ path: "development-assets", keep: 64 },
	{ path: "toolchains", keep: 8 },
	{ path: "source-digests", keep: 8 },
	{ path: "zig", keep: 2 },
	// The linker's ThinLTO cache; its files are independent and safe to remove between links.
	{ path: "thinlto", keep: 0, entryKind: "grandchildren" },
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
	targetBytes: number;
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
	/** Size to prune back to; defaults to the budget's target. */
	maxBytes?: number;
	minAgeMs?: number;
	/** Entries used within this window are never removed, even in an emergency. */
	protectMs?: number;
	dryRun?: boolean;
	nowMs?: number;
	freeBytes?: number;
	environment?: NodeJS.ProcessEnv;
}

export interface CacheBudget {
	/** Size at which maintenance prunes the cache. */
	maxBytes: number;
	/** Size maintenance prunes back to. */
	targetBytes: number;
}

export interface CacheUsage {
	schema: 1;
	bytes: number;
	measuredAt: number;
	removedBytes: number;
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
	// Dot entries are the cache's own leases, locks and usage records.
	return readdirSync(root)
		.filter((name) => !name.startsWith(".") && !MANAGED_ROOTS.has(name))
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
	const clearLockPath = globalClearLock(root);
	if (clearLockPath !== undefined && existsSync(clearLockPath)) {
		throw new Error("Maligator cache clear is active; retry the command shortly");
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
	if (clearLockPath !== undefined && existsSync(clearLockPath)) {
		rmSync(leasePath, { force: true });
		throw new Error("Maligator cache clear started concurrently; retry the command");
	}
	if (startCacheMaintenanceIfDue(root, { lowDiskOnly: true })) {
		process.stderr.write(
			`Maligator cache: less than ${formatCacheBytes(DISK_RESERVE_BYTES)} free on its volume; trimming it in the background.\n`,
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
			startCacheMaintenanceIfDue(root);
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

function lastUsedMs(target: string): number {
	try {
		const stats = statSync(target);
		return Math.max(stats.atimeMs, stats.mtimeMs, stats.birthtimeMs);
	} catch {
		return 0;
	}
}

/** Per-process scratch is named `<pid>-…` and belongs to that process while it runs. */
function scratchOwner(candidate: CacheEntry): number | undefined {
	if (candidate.family !== "work") return undefined;
	const pid = /^(\d+)-/.exec(path.basename(candidate.path))?.[1];
	return pid === undefined ? undefined : Number(pid);
}

function pruneLocked(
	root: string,
	before: CacheStatus,
	options: Required<
		Pick<CachePruneOptions, "maxBytes" | "minAgeMs" | "protectMs" | "nowMs" | "dryRun">
	>,
): CachePruneResult {
	const { maxBytes, minAgeMs, protectMs, nowMs, dryRun } = options;
	let projectedBytes = before.totalBytes;
	const emergency = before.totalBytes > maxBytes * 2;
	const removed: Array<CacheEntry> = [];
	const removedPaths = new Set<string>();
	// Commands keep running while maintenance does, so a candidate that a command used
	// after the scan stays; any read that still races a removal sees an ordinary miss.
	const remove = (candidate: CacheEntry): boolean => {
		if (removedPaths.has(candidate.path)) return false;
		if (!dryRun && nowMs - lastUsedMs(candidate.path) < protectMs) return false;
		removedPaths.add(candidate.path);
		removed.push(candidate);
		projectedBytes -= candidate.bytes;
		if (!dryRun) rmSync(candidate.path, { recursive: true, force: true });
		return true;
	};
	const eligible = (candidate: CacheEntry) => {
		const owner = scratchOwner(candidate);
		if (owner !== undefined && processIsAlive(owner)) return false;
		const age = nowMs - candidate.lastUsedMs;
		return age >= protectMs && (emergency || age >= minAgeMs);
	};

	// A crashed command leaves its scratch behind; it is garbage regardless of budget.
	for (const candidate of before.entries) {
		const owner = scratchOwner(candidate);
		if (
			owner !== undefined &&
			!processIsAlive(owner) &&
			nowMs - candidate.lastUsedMs >= protectMs
		)
			remove(candidate);
	}

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
		.filter(eligible)
		.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
		if (projectedBytes <= maxBytes) break;
		remove(blob);
	}

	const ordinary = before.entries.filter(
		(candidate) =>
			candidate.family !== "blobs" && !candidate.family.startsWith("actions/"),
	);
	const rustWork = (candidate: CacheEntry) =>
		candidate.family === "work" &&
		RUST_WORK_FAMILIES.has(path.basename(path.dirname(candidate.path)));
	const pruneOrdinaryFamily = (family: Array<CacheEntry>, keep: number) => {
		const retained = retainedPerFamily(family, keep);
		for (const candidate of family
			.filter((item) => !retained.has(item.path) && eligible(item))
			.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
			if (projectedBytes <= maxBytes) break;
			remove(candidate);
		}
	};
	for (const policy of CACHE_FAMILIES) {
		pruneOrdinaryFamily(
			ordinary.filter(
				(candidate) => candidate.family === policy.path && !rustWork(candidate),
			),
			policy.keep,
		);
	}

	const actionFamilies = new Set(actions.map((candidate) => candidate.family));
	const pruneActionFamily = (familyName: string) => {
		const family = actions.filter((candidate) => candidate.family === familyName);
		const retained = retainedPerFamily(family, 8);
		for (const candidate of family
			.filter((item) => !retained.has(item.path) && eligible(item))
			.sort((left, right) => left.lastUsedMs - right.lastUsedMs)) {
			if (projectedBytes <= maxBytes) break;
			const digests = new Set(actionBlobDigests(candidate.path));
			if (!remove(candidate)) continue;
			for (const digest of digests) {
				const remaining = (references.get(digest) ?? 1) - 1;
				references.set(digest, remaining);
				const blob = blobByDigest.get(digest);
				if (remaining === 0 && blob !== undefined) remove(blob);
			}
		}
	};
	for (const familyName of actionFamilies) {
		if (!RUST_ACTION_FAMILIES.has(familyName)) pruneActionFamily(familyName);
	}
	// Cargo products change less often than compiler work and generated actions.
	pruneOrdinaryFamily(ordinary.filter(rustWork), 2);
	for (const familyName of actionFamilies) {
		if (RUST_ACTION_FAMILIES.has(familyName)) pruneActionFamily(familyName);
	}

	if (!dryRun && removed.length > 0) {
		// The smoke marker means its native/runtime prerequisites are warm. Any
		// real artifact removal invalidates that premise, so the next gate must
		// use its cold-start fuse instead of reporting a false warm timeout.
		rmSync(path.join(root, TEST_SUITE_SMOKE_FILE), { force: true });
	}
	const removedBytes = removed.reduce((total, item) => total + item.bytes, 0);
	return {
		...before,
		totalBytes: Math.max(0, projectedBytes),
		managedBytes: Math.max(0, before.managedBytes - removedBytes),
		entries: before.entries.filter((item) => !removedPaths.has(item.path)),
		targetBytes: maxBytes,
		removedBytes,
		removed,
		dryRun,
	};
}

/**
 * Re-measures the cache around `measure`: growth recorded while it runs lands in a
 * fresh journal, so the next estimate starts from this measurement.
 */
function remeasure(
	root: string,
	nowMs: number,
	measure: () => { bytes: number; removedBytes: number },
): void {
	const journal = path.join(root, USAGE_JOURNAL);
	const rotated = `${journal}.${process.pid}-${randomUUID()}`;
	try {
		renameSync(journal, rotated);
	} catch {
		// Nothing was recorded since the last measurement.
	}
	const { bytes, removedBytes } = measure();
	writeFileAtomically(
		path.join(root, USAGE_FILE),
		`${JSON.stringify({ schema: 1, bytes, measuredAt: nowMs, removedBytes } satisfies CacheUsage)}\n`,
	);
	for (const name of readdirSync(root))
		if (name.startsWith(`${USAGE_JOURNAL}.`))
			rmSync(path.join(root, name), { force: true });
}

export function pruneMaligatorCache(options: CachePruneOptions = {}): CachePruneResult {
	const root = cacheRoot(options.cacheRoot);
	const nowMs = options.nowMs ?? Date.now();
	const dryRun = options.dryRun ?? false;
	const lockPath = acquirePruneLock(root);
	try {
		activeCacheCommands(root, true);
		let result: CachePruneResult | undefined;
		const prune = () => {
			const before = inspectMaligatorCache(root);
			const freeBytes = options.freeBytes ?? volumeFreeBytes(root);
			result = pruneLocked(root, before, {
				maxBytes:
					options.maxBytes ??
					cacheBudget(freeBytes + before.totalBytes, options.environment).targetBytes,
				minAgeMs: options.minAgeMs ?? DEFAULT_CACHE_MIN_AGE_MS,
				protectMs: options.protectMs ?? PROTECTION_MS,
				nowMs,
				dryRun,
			});
			return { bytes: result.totalBytes, removedBytes: result.removedBytes };
		};
		if (dryRun) prune();
		else remeasure(root, nowMs, prune);
		return result!;
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export interface CacheMaintenanceResult {
	budget: CacheBudget;
	freeBytes: number;
	measuredBytes: number;
	pruned?: CachePruneResult;
}

/**
 * What background maintenance does: measure the cache and, when it is over budget or
 * its volume is short of space, prune it back. Returns nothing while another
 * maintenance or prune holds the cache.
 */
export function maintainMaligatorCache(
	options: Pick<
		CachePruneOptions,
		"cacheRoot" | "nowMs" | "freeBytes" | "environment"
	> = {},
): CacheMaintenanceResult | undefined {
	const root = cacheRoot(options.cacheRoot);
	let lockPath: string;
	try {
		lockPath = acquirePruneLock(root);
	} catch {
		return undefined;
	}
	try {
		const nowMs = options.nowMs ?? Date.now();
		const freeBytes = options.freeBytes ?? volumeFreeBytes(root);
		activeCacheCommands(root, true);
		let result: CacheMaintenanceResult | undefined;
		remeasure(root, nowMs, () => {
			const before = inspectMaligatorCache(root);
			const budget = cacheBudget(freeBytes + before.totalBytes, options.environment);
			const lowDisk = freeBytes < DISK_RESERVE_BYTES;
			result = { budget, freeBytes, measuredBytes: before.totalBytes };
			if (before.totalBytes <= budget.maxBytes && !lowDisk)
				return { bytes: before.totalBytes, removedBytes: 0 };
			const shortfall = lowDisk ? 2 * DISK_RESERVE_BYTES - freeBytes : 0;
			result.pruned = pruneLocked(root, before, {
				maxBytes: Math.max(
					0,
					Math.min(budget.targetBytes, before.totalBytes - shortfall),
				),
				minAgeMs: 0,
				protectMs: lowDisk ? LOW_DISK_PROTECTION_MS : PROTECTION_MS,
				nowMs,
				dryRun: false,
			});
			return {
				bytes: result.pruned.totalBytes,
				removedBytes: result.pruned.removedBytes,
			};
		});
		return result;
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

/**
 * The size at which maintenance prunes and the size it prunes back to. A volume with
 * room to spare lets one cache hold several projects' work. The cache's own bytes
 * count as available so the tier does not flip as the cache fills the volume.
 */
export function cacheBudget(
	availableBytes: number,
	environment: NodeJS.ProcessEnv = process.env,
): CacheBudget {
	const configured = environment.MALIGATOR_CACHE_MAX_GB;
	if (configured !== undefined && configured !== "") {
		const gib = Number(configured);
		if (!Number.isFinite(gib) || gib <= 0)
			throw new Error(
				`MALIGATOR_CACHE_MAX_GB must be a positive number of GiB, got '${configured}'`,
			);
		return { maxBytes: gib * GIB, targetBytes: 0.75 * gib * GIB };
	}
	return availableBytes >= ROOMY_VOLUME_BYTES
		? { maxBytes: 100 * GIB, targetBytes: 40 * GIB }
		: { maxBytes: 20 * GIB, targetBytes: 15 * GIB };
}

export function volumeFreeBytes(root: string): number {
	let directory = path.resolve(root);
	while (!existsSync(directory) && path.dirname(directory) !== directory)
		directory = path.dirname(directory);
	const stats = statfsSync(directory);
	return stats.bavail * stats.bsize;
}

export function readCacheUsage(root: string): CacheUsage | undefined {
	try {
		const usage = JSON.parse(
			readFileSync(path.join(root, USAGE_FILE), "utf8"),
		) as Partial<CacheUsage>;
		return usage.schema === 1 &&
			typeof usage.bytes === "number" &&
			typeof usage.measuredAt === "number" &&
			typeof usage.removedBytes === "number"
			? (usage as CacheUsage)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Notes bytes a command added, so the size estimate stays current without a scan. */
export function recordCacheGrowth(root: string, bytes: number): void {
	try {
		appendFileSync(path.join(root, USAGE_JOURNAL), `${bytes}\n`);
	} catch {
		// The next scheduled measurement corrects a missed record.
	}
}

/** The last measurement plus recorded growth, or nothing before the first measurement. */
export function estimateCacheBytes(root: string): number | undefined {
	const usage = readCacheUsage(root);
	if (usage === undefined) return undefined;
	let recorded = 0;
	try {
		for (const line of readFileSync(path.join(root, USAGE_JOURNAL), "utf8").split("\n")) {
			const bytes = Number(line);
			if (line !== "" && Number.isSafeInteger(bytes) && bytes > 0) recorded += bytes;
		}
	} catch {
		// No growth recorded since the measurement.
	}
	return usage.bytes + recorded;
}

let maintenanceCommand: ReadonlyArray<string> | undefined;

/** How this host invokes its own CLI; the product binary is its own CLI. */
export function setCacheMaintenanceCommand(command: ReadonlyArray<string>): void {
	maintenanceCommand = command;
}

function launchMaintenance(): void {
	const [executable, ...args] = maintenanceCommand ?? [
		process.execPath,
		path.join(import.meta.dirname, "index.ts"),
	];
	spawn(executable!, [...args, "cache", "maintain"], {
		detached: true,
		stdio: "ignore",
	}).unref();
}

export interface CacheMaintenanceTrigger {
	/** Only start for a volume short of space, as at the start of a command. */
	lowDiskOnly?: boolean;
	nowMs?: number;
	freeBytes?: number;
	environment?: NodeJS.ProcessEnv;
}

/**
 * Starts background maintenance of the user's cache when it is due. Costs a free-space
 * query and two small reads, and never delays or fails the calling command. CI runners
 * are discarded after each job and save their cache explicitly, so they opt out.
 */
export function startCacheMaintenanceIfDue(
	root: string,
	trigger: CacheMaintenanceTrigger = {},
): boolean {
	try {
		const environment = trigger.environment ?? process.env;
		if (
			environment.MALIGATOR_CACHE_MAINTENANCE === "off" ||
			environment.CI === "true" ||
			path.resolve(root) !== maligatorCacheDirectory(undefined, environment)
		)
			return false;
		const nowMs = trigger.nowMs ?? Date.now();
		const freeBytes = trigger.freeBytes ?? volumeFreeBytes(root);
		let due = freeBytes < DISK_RESERVE_BYTES;
		if (!due && trigger.lowDiskOnly !== true) {
			const usage = readCacheUsage(root);
			const estimate = estimateCacheBytes(root);
			due =
				usage === undefined ||
				estimate === undefined ||
				nowMs - usage.measuredAt >= MAINTENANCE_INTERVAL_MS ||
				estimate > cacheBudget(freeBytes + estimate, environment).maxBytes;
		}
		if (!due || existsSync(path.join(root, PRUNE_LOCK))) return false;
		const marker = path.join(root, MAINTENANCE_MARKER);
		if (existsSync(marker) && nowMs - statSync(marker).mtimeMs < MAINTENANCE_RETRY_MS)
			return false;
		writeFileSync(marker, `${process.pid}\n`);
		launchMaintenance();
		return true;
	} catch {
		return false;
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

export const DEFAULT_CACHE_MIN_AGE_MS = DAY;

export function formatCacheBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < GIB) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / GIB).toFixed(2)} GiB`;
}
