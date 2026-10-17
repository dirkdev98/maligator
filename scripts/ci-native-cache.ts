import { hash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { maligatorCacheDirectory } from "../src/cache-root.ts";

const usage = `usage: node scripts/ci-native-cache.ts import DIRECTORY [--shared]
       node scripts/ci-native-cache.ts export DIRECTORY --shared
       node scripts/ci-native-cache.ts export DIRECTORY [--without-shared | --without SHARED]

Moves completed Rust library, compiler overlay, runtime C objects and archives,
generated C and Wasm actions, eval-compiler bakes, then ThinLTO cache entries,
between the Maligator cache and a GitHub Actions cache directory. All of them are
content-addressed: a restored entry whose inputs no longer match is never read, so a
stale snapshot only costs its download. import verifies every blob, bake file and
ThinLTO entry before publishing it and keeps each one's last-use time; export keeps
what was read within 14 days of the most recent use: first the bakes and then the
actions this job read, then ThinLTO entries, then older actions, each in stage order
and newest first. It reports a digest so unchanged snapshots are not saved again.

The Rust libraries, runtime objects and archives, compiler overlay objects and bakes
of a lane are the same in all of its jobs, so they travel in one shared snapshot per
lane. --shared exports only those for the job that owns the lane's shared snapshot;
a job line leaves out everything the restored shared snapshot holds (--without), or
every shared stage when its job owns the shared snapshot (--without-shared).`;

// Earlier stages are costlier to rebuild and are read first in a job, so a full
// snapshot keeps them before the many cheap fixture objects that follow.
const STAGES = [
	"rust-library",
	"wasm-rust",
	"compiler-overlay-object",
	"runtime-object",
	"runtime-archive",
	"wasm-object",
	"wasm-archive",
	"generated-unit-slice",
	"generated-object",
	"wasm-link",
	"test262-input-index",
];
// Linkers write these and never touch them on a hit, so recency is their write time.
const THINLTO = "thinlto";
const THINLTO_MANIFEST = "thinlto.json";
// Bake directories are named by their compiler source key and validated on every read;
// a hit touches `artifact.json`, so its time is the bake's last use.
const BAKES = "compiler-wire";
const BAKE_RECORD = "artifact.json";
const BAKES_MANIFEST = "compiler-wire.json";

interface BakeFile {
	name: string;
	digest: string;
	size: number;
}

interface Bake {
	directory: string;
	mtimeMs: number;
	files: Array<BakeFile>;
}

interface ThinLtoEntry {
	file: string;
	digest: string;
	size: number;
	mtimeMs: number;
}
// The stages every job of a lane reads alike; see the usage text.
const SHARED_STAGES = new Set([
	"rust-library",
	"compiler-overlay-object",
	"runtime-object",
	"runtime-archive",
]);
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// Snapshots compress about 3.5x in the Actions cache. The newest snapshot of every line
// and shared snapshot must stay inside the repository's 10 GB allowance, or eviction
// drops whole lines and their jobs start cold.
const LINE_MAX_BYTES = 3 * 1024 ** 3;
const SHARED_MAX_BYTES = 3 * 1024 ** 3;

interface Entry {
	manifest: string;
	stage: number;
	stageName: string;
	outputs: Array<{ digest: string; size: number }>;
	mtimeMs: number;
	bytes: number;
}

function blob(root: string, digest: string): string {
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid blob digest: ${digest}`);
	return path.join(root, "blobs", "sha256", digest.slice(0, 2), digest.slice(2));
}

function readEntries(root: string): Array<Entry> {
	return STAGES.flatMap((stage, stageIndex) => {
		const directory = path.join(root, "actions", stage);
		let files: Array<string>;
		try {
			files = readdirSync(directory, { recursive: true, encoding: "utf8" });
		} catch {
			return [];
		}
		return files
			.filter((file) => file.endsWith(".json"))
			.flatMap((file) => {
				const manifest = path.join("actions", stage, file);
				try {
					const parsed = JSON.parse(readFileSync(path.join(root, manifest), "utf8")) as {
						outputs?: Array<{ digest?: unknown; size?: unknown }>;
					};
					const outputs = (parsed.outputs ?? []).map(({ digest, size }) => {
						if (
							typeof digest !== "string" ||
							!/^[0-9a-f]{64}$/.test(digest) ||
							typeof size !== "number" ||
							!Number.isSafeInteger(size)
						) {
							throw new Error("invalid output");
						}
						return { digest, size };
					});
					if (outputs.length === 0) return [];
					return [
						{
							manifest,
							stage: stageIndex,
							stageName: stage,
							outputs,
							mtimeMs: statSync(path.join(root, manifest)).mtimeMs,
							bytes: outputs.reduce((total, output) => total + output.size, 0),
						},
					];
				} catch {
					return [];
				}
			});
	});
}

function snapshotDigest(
	entries: ReadonlyArray<Entry>,
	thinLto: ReadonlyArray<ThinLtoEntry> = [],
	bakes: ReadonlyArray<Bake> = [],
): string {
	return hash(
		"sha256",
		JSON.stringify([
			...entries
				.map((entry) => [entry.manifest, ...entry.outputs.map((output) => output.digest)])
				.sort((left, right) => (left[0]! < right[0]! ? -1 : 1)),
			...thinLto
				.map((entry) => [entry.file, entry.digest])
				.sort((left, right) => (left[0]! < right[0]! ? -1 : 1)),
			...bakes
				.map((bake) => [bake.directory, ...bake.files.map((file) => file.digest)])
				.sort((left, right) => (left[0]! < right[0]! ? -1 : 1)),
		]),
		"hex",
	);
}

/** Complete bake directories, newest use first, without file digests. */
function readBakes(root: string): Array<Omit<Bake, "files"> & { files: Array<string> }> {
	let directories: Array<string>;
	try {
		directories = readdirSync(path.join(root, BAKES));
	} catch {
		return [];
	}
	return directories
		.filter((directory) => /^[0-9a-f]{64}$/.test(directory))
		.flatMap((directory) => {
			try {
				const files = readdirSync(path.join(root, BAKES, directory)).filter(
					(name) => !name.startsWith("."),
				);
				const record = statSync(path.join(root, BAKES, directory, BAKE_RECORD));
				return files.includes(BAKE_RECORD)
					? [{ directory, mtimeMs: record.mtimeMs, files }]
					: [];
			} catch {
				return [];
			}
		})
		.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readBakesManifest(directory: string): Array<Bake> {
	try {
		const bakes = JSON.parse(
			readFileSync(path.join(directory, BAKES_MANIFEST), "utf8"),
		) as Array<Bake>;
		return bakes.filter(
			(bake) =>
				/^[0-9a-f]{64}$/.test(bake.directory) &&
				Number.isFinite(bake.mtimeMs) &&
				Array.isArray(bake.files) &&
				bake.files.some((file) => file.name === BAKE_RECORD) &&
				bake.files.every(
					(file) =>
						typeof file.name === "string" &&
						/^[\w.-]+$/.test(file.name) &&
						!file.name.startsWith(".") &&
						/^[0-9a-f]{64}$/.test(file.digest) &&
						Number.isSafeInteger(file.size),
				),
		);
	} catch {
		return [];
	}
}

/** ThinLTO cache files as `<cache key directory>/<entry>`, newest first. */
function readThinLtoFiles(
	root: string,
): Array<{ file: string; size: number; mtimeMs: number }> {
	let directories: Array<string>;
	try {
		directories = readdirSync(path.join(root, THINLTO));
	} catch {
		return [];
	}
	return directories
		.flatMap((directory) => {
			let names: Array<string>;
			try {
				names = readdirSync(path.join(root, THINLTO, directory));
			} catch {
				return [];
			}
			return names
				.filter((name) => name.startsWith("llvmcache-"))
				.flatMap((name) => {
					const file = path.join(directory, name);
					const stats = statSync(path.join(root, THINLTO, file), {
						throwIfNoEntry: false,
					});
					return stats?.isFile() === true
						? [{ file, size: stats.size, mtimeMs: stats.mtimeMs }]
						: [];
				});
		})
		.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readThinLtoManifest(directory: string): Array<ThinLtoEntry> {
	try {
		const entries = JSON.parse(
			readFileSync(path.join(directory, THINLTO_MANIFEST), "utf8"),
		) as Array<ThinLtoEntry>;
		return entries.filter(
			(entry) =>
				typeof entry.file === "string" &&
				/^[0-9a-f]+[\\/]llvmcache-[\w-]+$/.test(entry.file) &&
				/^[0-9a-f]{64}$/.test(entry.digest) &&
				Number.isSafeInteger(entry.size) &&
				Number.isFinite(entry.mtimeMs),
		);
	} catch {
		return [];
	}
}

function copyAtomically(source: string, destination: string): void {
	mkdirSync(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${process.pid}-${randomUUID()}`;
	try {
		copyFileSync(source, temporary);
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function validBlob(file: string, digest: string, size: number): boolean {
	try {
		return (
			statSync(file).size === size && hash("sha256", readFileSync(file), "hex") === digest
		);
	} catch {
		return false;
	}
}

function appendGitHubFile(file: string | undefined, line: string): void {
	if (file !== undefined && file !== "") appendFileSync(file, `${line}\n`);
}

export function importSnapshot(
	directory: string,
	root: string,
	part: "shared" | "line" = "line",
): void {
	const imported: Array<Entry> = [];
	for (const entry of readEntries(directory)) {
		const valid = entry.outputs.every((output) =>
			validBlob(blob(directory, output.digest), output.digest, output.size),
		);
		if (!valid) {
			console.warn(`[ci-native-cache] skipped corrupt ${entry.manifest}`);
			continue;
		}
		for (const output of entry.outputs) {
			const destination = blob(root, output.digest);
			if (!validBlob(destination, output.digest, output.size)) {
				copyAtomically(blob(directory, output.digest), destination);
			}
		}
		const manifest = path.join(root, entry.manifest);
		copyAtomically(path.join(directory, entry.manifest), manifest);
		const lastUse = new Date(entry.mtimeMs);
		utimesSync(manifest, lastUse, lastUse);
		imported.push(entry);
	}
	const thinLto: Array<ThinLtoEntry> = [];
	for (const entry of readThinLtoManifest(directory)) {
		const source = path.join(directory, THINLTO, entry.file);
		if (!validBlob(source, entry.digest, entry.size)) {
			console.warn(`[ci-native-cache] skipped corrupt ThinLTO entry ${entry.file}`);
			continue;
		}
		const destination = path.join(root, THINLTO, entry.file);
		copyAtomically(source, destination);
		const lastUse = new Date(entry.mtimeMs);
		utimesSync(destination, lastUse, lastUse);
		thinLto.push(entry);
	}
	const bakes: Array<Bake> = [];
	for (const bake of readBakesManifest(directory)) {
		const source = path.join(directory, BAKES, bake.directory);
		if (
			!bake.files.every((file) =>
				validBlob(path.join(source, file.name), file.digest, file.size),
			)
		) {
			console.warn(`[ci-native-cache] skipped corrupt compiler bake ${bake.directory}`);
			continue;
		}
		const destination = path.join(root, BAKES, bake.directory);
		// The record goes last, so a partly copied bake is never read as complete.
		const ordered = [
			...bake.files.filter((file) => file.name !== BAKE_RECORD),
			...bake.files.filter((file) => file.name === BAKE_RECORD),
		];
		for (const file of ordered)
			copyAtomically(path.join(source, file.name), path.join(destination, file.name));
		const lastUse = new Date(bake.mtimeMs);
		utimesSync(path.join(destination, BAKE_RECORD), lastUse, lastUse);
		bakes.push(bake);
	}
	const bytes = [
		...imported,
		...thinLto.map((entry) => ({ bytes: entry.size })),
		...bakes.flatMap((bake) => bake.files.map((file) => ({ bytes: file.size }))),
	].reduce((total, entry) => total + entry.bytes, 0);
	console.log(
		`[ci-native-cache] imported ${imported.length} actions, ${bakes.length} compiler bakes and ${thinLto.length} ThinLTO entries (${mebibytes(bytes)}) from the ${part === "shared" ? "shared" : "job"} snapshot into ${root}`,
	);
	appendGitHubFile(
		process.env.GITHUB_ENV,
		`${part === "shared" ? "MALIGATOR_NATIVE_SHARED_RESTORED" : "MALIGATOR_NATIVE_CACHE_RESTORED"}=${imported.length + thinLto.length + bakes.length === 0 ? "" : snapshotDigest(imported, thinLto, bakes)}`,
	);
	// Restored manifests keep older times, so anything newer was read or built by this job.
	appendGitHubFile(
		process.env.GITHUB_ENV,
		`MALIGATOR_NATIVE_CACHE_IMPORTED_AT=${Date.now()}`,
	);
}

function mebibytes(bytes: number): string {
	return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/** The action manifests and bake directories a restored snapshot holds. */
export function snapshotContents(directory: string): Set<string> {
	return new Set([
		...readEntries(directory).map((entry) => entry.manifest),
		...readBakesManifest(directory).map((bake) => path.join(BAKES, bake.directory)),
	]);
}

export interface ExportOptions {
	maxBytes?: number;
	/** When this job's imports finished; without it every action and bake counts as used. */
	usedSinceMs?: number;
	/** `shared` holds only the shared stages and bakes. */
	part?: "shared" | "line";
	/**
	 * What a job line leaves to the shared snapshot: everything restored from there, or
	 * every shared stage and bake when this job saves the shared snapshot itself.
	 */
	withoutShared?: ReadonlySet<string> | "all";
}

/**
 * Snapshot what this job used first: bakes, then actions it read since `usedSinceMs`,
 * then ThinLTO entries, then older actions, so a snapshot at the cap drops what the job
 * did not need. A bake replaces about a minute of compilation per job, more than any
 * equal share of fixture objects.
 */
export function exportSnapshot(
	directory: string,
	root: string,
	options: ExportOptions = {},
): void {
	const part = options.part ?? "line";
	const maxBytes =
		options.maxBytes ?? (part === "shared" ? SHARED_MAX_BYTES : LINE_MAX_BYTES);
	const { usedSinceMs, withoutShared } = options;
	rmSync(directory, { recursive: true, force: true });
	const leftToShared = (key: string, shared: boolean) =>
		part === "line" &&
		(withoutShared === "all" ? shared : withoutShared?.has(key) === true);
	let leftBytes = 0;
	const entries = readEntries(root)
		.filter((entry) => {
			const shared = SHARED_STAGES.has(entry.stageName);
			if (part === "shared") return shared;
			if (!leftToShared(entry.manifest, shared)) return true;
			leftBytes += entry.bytes;
			return false;
		})
		.sort((left, right) => left.stage - right.stage || right.mtimeMs - left.mtimeMs);
	const cutoff =
		entries.reduce((newest, entry) => Math.max(newest, entry.mtimeMs), 0) - RETENTION_MS;
	const used = (mtimeMs: number) => usedSinceMs === undefined || mtimeMs >= usedSinceMs;
	const exported: Array<Entry> = [];
	const breakdown = { used: 0, older: 0, bakes: 0, thinLto: 0 };
	let bytes = 0;
	const exportActions = (selected: ReadonlyArray<Entry>, category: "used" | "older") => {
		for (const entry of selected) {
			if (entry.mtimeMs < cutoff || bytes + entry.bytes > maxBytes) continue;
			const sources = entry.outputs.map((output) => blob(root, output.digest));
			if (
				sources.some(
					(source, index) =>
						statSync(source, { throwIfNoEntry: false })?.size !==
						entry.outputs[index]!.size,
				)
			) {
				continue;
			}
			for (const [index, source] of sources.entries()) {
				copyAtomically(source, blob(directory, entry.outputs[index]!.digest));
			}
			const manifest = path.join(directory, entry.manifest);
			copyAtomically(path.join(root, entry.manifest), manifest);
			const lastUse = new Date(entry.mtimeMs);
			utimesSync(manifest, lastUse, lastUse);
			exported.push(entry);
			bytes += entry.bytes;
			breakdown[category] += entry.bytes;
		}
	};
	const allBakes = readBakes(root);
	const bakeCutoff = (allBakes[0]?.mtimeMs ?? 0) - RETENTION_MS;
	const bakes: Array<Bake> = [];
	for (const bake of allBakes) {
		const source = path.join(root, BAKES, bake.directory);
		const sizes = bake.files.map((name) => statSync(path.join(source, name)).size);
		const size = sizes.reduce((total, fileSize) => total + fileSize, 0);
		if (leftToShared(path.join(BAKES, bake.directory), true)) {
			leftBytes += size;
			continue;
		}
		// The shared snapshot keeps bakes other jobs of its lane read; a line only its own.
		if (part === "line" ? !used(bake.mtimeMs) : bake.mtimeMs < bakeCutoff) continue;
		if (bytes + size > maxBytes) continue;
		const destination = path.join(directory, BAKES, bake.directory);
		const files = bake.files.map((name, index) => {
			copyAtomically(path.join(source, name), path.join(destination, name));
			return {
				name,
				digest: hash("sha256", readFileSync(path.join(destination, name)), "hex"),
				size: sizes[index]!,
			};
		});
		bakes.push({ directory: bake.directory, mtimeMs: bake.mtimeMs, files });
		bytes += size;
		breakdown.bakes += size;
	}
	if (bakes.length > 0) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, BAKES_MANIFEST), JSON.stringify(bakes));
	}
	exportActions(
		entries.filter((entry) => used(entry.mtimeMs)),
		"used",
	);
	const thinLto: Array<ThinLtoEntry> = [];
	if (part === "line") {
		const thinLtoFiles = readThinLtoFiles(root);
		const thinLtoCutoff = (thinLtoFiles[0]?.mtimeMs ?? 0) - RETENTION_MS;
		for (const file of thinLtoFiles) {
			if (file.mtimeMs < thinLtoCutoff || bytes + file.size > maxBytes) continue;
			const source = path.join(root, THINLTO, file.file);
			const destination = path.join(directory, THINLTO, file.file);
			copyAtomically(source, destination);
			const lastUse = new Date(file.mtimeMs);
			utimesSync(destination, lastUse, lastUse);
			thinLto.push({ ...file, digest: hash("sha256", readFileSync(destination), "hex") });
			bytes += file.size;
			breakdown.thinLto += file.size;
		}
		if (thinLto.length > 0) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(path.join(directory, THINLTO_MANIFEST), JSON.stringify(thinLto));
		}
	}
	exportActions(
		entries.filter((entry) => !used(entry.mtimeMs)),
		"older",
	);
	const digest =
		exported.length + thinLto.length + bakes.length === 0
			? ""
			: snapshotDigest(exported, thinLto, bakes);
	console.log(
		`[ci-native-cache] exported ${exported.length} actions, ${bakes.length} compiler bakes and ${thinLto.length} ThinLTO entries (${mebibytes(bytes)} of ${mebibytes(maxBytes)}) to the ${part === "shared" ? "shared" : "job"} snapshot ${directory}${digest === "" ? "" : ` · ${digest}`}`,
	);
	console.log(
		`[ci-native-cache] actions this job read ${mebibytes(breakdown.used)}, older actions ${mebibytes(breakdown.older)}, bakes ${mebibytes(breakdown.bakes)}, ThinLTO ${mebibytes(breakdown.thinLto)}${part === "line" ? `, left to the shared snapshot ${mebibytes(leftBytes)}` : ""}`,
	);
	appendGitHubFile(process.env.GITHUB_OUTPUT, `digest=${digest}`);
}

function main(): void {
	const [command, directory, ...flags] = process.argv.slice(2);
	if (command === "-h" || command === "--help") {
		console.log(usage);
		process.exit(0);
	}
	if ((command !== "import" && command !== "export") || directory === undefined) {
		console.error(usage);
		process.exit(1);
	}
	const root = maligatorCacheDirectory();
	const snapshot = path.resolve(directory);
	if (command === "import" && flags.length === 0) importSnapshot(snapshot, root);
	else if (command === "import" && flags.join(" ") === "--shared")
		importSnapshot(snapshot, root, "shared");
	else if (command === "export") {
		const importedAt = Number(process.env.MALIGATOR_NATIVE_CACHE_IMPORTED_AT);
		const usedSinceMs =
			Number.isFinite(importedAt) && importedAt > 0 ? importedAt : undefined;
		if (flags.join(" ") === "--shared")
			exportSnapshot(snapshot, root, { part: "shared", usedSinceMs });
		else if (flags.join(" ") === "--without-shared")
			exportSnapshot(snapshot, root, { usedSinceMs, withoutShared: "all" });
		else if (flags.length === 2 && flags[0] === "--without")
			exportSnapshot(snapshot, root, {
				usedSinceMs,
				withoutShared: snapshotContents(path.resolve(flags[1]!)),
			});
		else if (flags.length === 0) exportSnapshot(snapshot, root, { usedSinceMs });
		else {
			console.error(usage);
			process.exit(1);
		}
	} else {
		console.error(usage);
		process.exit(1);
	}
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
