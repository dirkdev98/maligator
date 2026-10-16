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

const usage = `usage: node scripts/ci-native-cache.ts import|export DIRECTORY

Moves completed Rust library, compiler overlay, runtime C objects and archives,
generated C and Wasm actions, eval-compiler bakes, then ThinLTO cache entries,
between the Maligator cache and a GitHub Actions cache directory. All of them are
content-addressed: a restored entry whose inputs no longer match is never read, so a
stale snapshot only costs its download. import verifies every blob, bake file and
ThinLTO entry before publishing it and keeps each one's last-use time; export keeps
what was read within 14 days of the most recent use, within 2 GiB: first the bakes
and then the actions this job read, then ThinLTO entries, then older actions, each
in stage order and newest first. It reports a digest so unchanged snapshots are not
saved again.`;

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
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 ** 3;

interface Entry {
	manifest: string;
	stage: number;
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

export function importSnapshot(directory: string, root: string): void {
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
		`[ci-native-cache] imported ${imported.length} actions, ${bakes.length} compiler bakes and ${thinLto.length} ThinLTO entries (${(bytes / 1024 ** 2).toFixed(1)} MiB) into ${root}`,
	);
	appendGitHubFile(
		process.env.GITHUB_ENV,
		`MALIGATOR_NATIVE_CACHE_RESTORED=${imported.length + thinLto.length + bakes.length === 0 ? "" : snapshotDigest(imported, thinLto, bakes)}`,
	);
	// Restored manifests keep older times, so anything newer was read or built by this job.
	appendGitHubFile(
		process.env.GITHUB_ENV,
		`MALIGATOR_NATIVE_CACHE_IMPORTED_AT=${Date.now()}`,
	);
}

/**
 * Snapshot what this job used first: bakes, then actions it read since `usedSinceMs`,
 * then ThinLTO entries, then older actions, so a line at the cap drops what the job did
 * not need. A bake replaces about a minute of compilation per job, more than any equal
 * share of fixture objects. Without a start time every action and bake counts as used.
 */
export function exportSnapshot(
	directory: string,
	root: string,
	maxBytes = MAX_BYTES,
	usedSinceMs?: number,
): void {
	rmSync(directory, { recursive: true, force: true });
	const entries = readEntries(root).sort(
		(left, right) => left.stage - right.stage || right.mtimeMs - left.mtimeMs,
	);
	const cutoff =
		entries.reduce((newest, entry) => Math.max(newest, entry.mtimeMs), 0) - RETENTION_MS;
	const used = (entry: Entry) =>
		usedSinceMs === undefined || entry.mtimeMs >= usedSinceMs;
	const exported: Array<Entry> = [];
	let bytes = 0;
	const exportActions = (selected: ReadonlyArray<Entry>) => {
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
		}
	};
	const bakes: Array<Bake> = [];
	for (const bake of readBakes(root)) {
		if (usedSinceMs !== undefined && bake.mtimeMs < usedSinceMs) continue;
		const source = path.join(root, BAKES, bake.directory);
		const sizes = bake.files.map((name) => statSync(path.join(source, name)).size);
		const size = sizes.reduce((total, fileSize) => total + fileSize, 0);
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
	}
	if (bakes.length > 0) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, BAKES_MANIFEST), JSON.stringify(bakes));
	}
	exportActions(entries.filter(used));
	const thinLtoFiles = readThinLtoFiles(root);
	const thinLtoCutoff = (thinLtoFiles[0]?.mtimeMs ?? 0) - RETENTION_MS;
	const thinLto: Array<ThinLtoEntry> = [];
	for (const file of thinLtoFiles) {
		if (file.mtimeMs < thinLtoCutoff || bytes + file.size > maxBytes) continue;
		const source = path.join(root, THINLTO, file.file);
		const destination = path.join(directory, THINLTO, file.file);
		copyAtomically(source, destination);
		const lastUse = new Date(file.mtimeMs);
		utimesSync(destination, lastUse, lastUse);
		thinLto.push({ ...file, digest: hash("sha256", readFileSync(destination), "hex") });
		bytes += file.size;
	}
	if (thinLto.length > 0) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, THINLTO_MANIFEST), JSON.stringify(thinLto));
	}
	exportActions(entries.filter((entry) => !used(entry)));
	const digest =
		exported.length + thinLto.length + bakes.length === 0
			? ""
			: snapshotDigest(exported, thinLto, bakes);
	console.log(
		`[ci-native-cache] exported ${exported.length} actions, ${bakes.length} compiler bakes and ${thinLto.length} ThinLTO entries (${(bytes / 1024 ** 2).toFixed(1)} MiB) to ${directory}${digest === "" ? "" : ` · ${digest}`}`,
	);
	appendGitHubFile(process.env.GITHUB_OUTPUT, `digest=${digest}`);
}

function main(): void {
	const [command, directory, ...rest] = process.argv.slice(2);
	if (command === "-h" || command === "--help") {
		console.log(usage);
		process.exit(0);
	}
	if (
		(command !== "import" && command !== "export") ||
		directory === undefined ||
		rest.length > 0
	) {
		console.error(usage);
		process.exit(1);
	}
	const root = maligatorCacheDirectory();
	if (command === "import") importSnapshot(path.resolve(directory), root);
	else {
		const importedAt = Number(process.env.MALIGATOR_NATIVE_CACHE_IMPORTED_AT);
		exportSnapshot(
			path.resolve(directory),
			root,
			MAX_BYTES,
			Number.isFinite(importedAt) && importedAt > 0 ? importedAt : undefined,
		);
	}
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
