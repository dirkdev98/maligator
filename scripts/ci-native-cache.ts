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
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { maligatorCacheDirectory } from "../src/cache-root.ts";

const usage = `usage: node scripts/ci-native-cache.ts import|export DIRECTORY

Moves completed Rust library, compiler overlay, runtime C and generated C object
actions between the Maligator cache and a GitHub Actions cache directory. Actions are
content-addressed: a restored action whose sources, features, toolchain or
environment no longer match is never read, so a stale snapshot only costs its
download. import verifies every blob before publishing it and keeps each manifest's
last-use time; export keeps the actions read within 14 days of the most recent one,
within 2 GiB, in stage order and newest first within a stage, and reports a digest
so unchanged snapshots are not saved again.`;

// Earlier stages are costlier to rebuild and are read first in a job, so a full
// snapshot keeps them before the many cheap fixture objects that follow.
const STAGES = [
	"rust-library",
	"compiler-overlay-object",
	"runtime-object",
	"generated-object",
];
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

function snapshotDigest(entries: ReadonlyArray<Entry>): string {
	return hash(
		"sha256",
		JSON.stringify(
			entries
				.map((entry) => [entry.manifest, ...entry.outputs.map((output) => output.digest)])
				.sort((left, right) => (left[0]! < right[0]! ? -1 : 1)),
		),
		"hex",
	);
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
	const bytes = imported.reduce((total, entry) => total + entry.bytes, 0);
	console.log(
		`[ci-native-cache] imported ${imported.length} actions (${(bytes / 1024 ** 2).toFixed(1)} MiB) into ${root}`,
	);
	appendGitHubFile(
		process.env.GITHUB_ENV,
		`MALIGATOR_NATIVE_CACHE_RESTORED=${imported.length === 0 ? "" : snapshotDigest(imported)}`,
	);
}

export function exportSnapshot(
	directory: string,
	root: string,
	maxBytes = MAX_BYTES,
): void {
	rmSync(directory, { recursive: true, force: true });
	const entries = readEntries(root).sort(
		(left, right) => left.stage - right.stage || right.mtimeMs - left.mtimeMs,
	);
	const cutoff =
		entries.reduce((newest, entry) => Math.max(newest, entry.mtimeMs), 0) - RETENTION_MS;
	const exported: Array<Entry> = [];
	let bytes = 0;
	for (const entry of entries) {
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
	const digest = exported.length === 0 ? "" : snapshotDigest(exported);
	console.log(
		`[ci-native-cache] exported ${exported.length} actions (${(bytes / 1024 ** 2).toFixed(1)} MiB) to ${directory}${digest === "" ? "" : ` · ${digest}`}`,
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
	else exportSnapshot(path.resolve(directory), root);
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
