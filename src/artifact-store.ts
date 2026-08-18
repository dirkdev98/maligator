import { hash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { MALIGATOR_VERSION } from "./version.ts";

const ACTION_SCHEMA = 1;
const validatedBlobs = new Map<string, string>();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

type Json = null | boolean | number | string | Array<Json> | { [key: string]: Json };

export interface ArtifactOutput {
	name: string;
	digest: string;
	size: number;
	mode: number;
	path: string;
}

interface ArtifactActionManifest {
	schema: 1;
	stage: string;
	producer: string;
	action: string;
	maligatorVersion: string;
	createdAt: number;
	outputs: Array<Omit<ArtifactOutput, "path">>;
}

export interface ArtifactAction {
	stage: string;
	producer: string;
	action: string;
	outputs: Array<ArtifactOutput>;
}

export interface ArtifactPublication {
	name: string;
	file: string;
	mode?: number;
}

function canonical(value: unknown): Json {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("cache identities require finite numbers");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter((entry) => entry[1] !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([name, entry]) => [name, canonical(entry)]),
		);
	}
	throw new Error(`unsupported cache identity value: ${typeof value}`);
}

export function artifactDigest(value: string | Uint8Array): string {
	return hash("sha256", value, "hex");
}

export function artifactIdentity(value: unknown): string {
	return artifactDigest(JSON.stringify(canonical(value)));
}

export function artifactProducer(
	stage: string,
	protocol: number,
	implementationDigest: string,
): string {
	assertSegment("stage", stage);
	return artifactIdentity({ stage, protocol, implementationDigest });
}

export function artifactActionKey(producer: string, inputs: unknown): string {
	return artifactIdentity({ producer, inputs });
}

function assertDigest(label: string, value: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

function assertSegment(label: string, value: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

function assertOutputName(value: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error(`invalid artifact output name: ${value}`);
	}
}

export function artifactBlobPath(root: string, digest: string): string {
	assertDigest("artifact digest", digest);
	return path.join(root, "blobs", "sha256", digest.slice(0, 2), digest.slice(2));
}

function actionManifestPath(
	root: string,
	stage: string,
	producer: string,
	action: string,
): string {
	assertSegment("stage", stage);
	assertDigest("producer digest", producer);
	assertDigest("action digest", action);
	return path.join(root, "actions", stage, producer, `${action}.json`);
}

function fileDigest(file: string): string {
	return artifactDigest(new Uint8Array(readFileSync(file)));
}

function validBlob(file: string, digest: string, size: number): boolean {
	try {
		const stats = statSync(file);
		if (!stats.isFile() || stats.size !== size) return false;
		const identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
		if (validatedBlobs.get(file) === identity) return true;
		if (fileDigest(file) !== digest) return false;
		validatedBlobs.set(file, identity);
		return true;
	} catch {
		return false;
	}
}

function publishFileAtomically(source: string, destination: string): void {
	const directory = path.dirname(destination);
	mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.publish-${process.pid}-${randomUUID()}`);
	try {
		copyFileSync(source, temporary);
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function publishTextAtomically(contents: string, destination: string): void {
	const directory = path.dirname(destination);
	mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.publish-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporary, contents, { flag: "wx" });
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function readArtifactAction(
	root: string,
	stage: string,
	producer: string,
	action: string,
): ArtifactAction | undefined {
	const manifestPath = actionManifestPath(root, stage, producer, action);
	try {
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		) as ArtifactActionManifest;
		if (
			manifest.schema !== ACTION_SCHEMA ||
			manifest.stage !== stage ||
			manifest.producer !== producer ||
			manifest.action !== action ||
			!Array.isArray(manifest.outputs) ||
			manifest.outputs.length === 0
		) {
			return undefined;
		}
		const names = new Set<string>();
		const outputs = manifest.outputs.map((output) => {
			assertOutputName(output.name);
			assertDigest("output digest", output.digest);
			if (
				names.has(output.name) ||
				!Number.isSafeInteger(output.size) ||
				output.size < 0 ||
				!Number.isSafeInteger(output.mode)
			) {
				throw new Error("invalid artifact action output");
			}
			names.add(output.name);
			const blob = artifactBlobPath(root, output.digest);
			if (!validBlob(blob, output.digest, output.size)) {
				rmSync(blob, { force: true });
				throw new Error("artifact blob is missing or corrupt");
			}
			return { ...output, path: blob };
		});
		const now = new Date();
		utimesSync(manifestPath, now, now);
		return { stage, producer, action, outputs };
	} catch {
		return undefined;
	}
}

export function publishArtifactAction(
	root: string,
	stage: string,
	producer: string,
	action: string,
	publications: ReadonlyArray<ArtifactPublication>,
): ArtifactAction {
	if (publications.length === 0) throw new Error("an artifact action needs an output");
	const names = new Set<string>();
	const outputs = publications.map((publication) => {
		assertOutputName(publication.name);
		if (names.has(publication.name)) {
			throw new Error(`duplicate artifact output: ${publication.name}`);
		}
		names.add(publication.name);
		const stats = statSync(publication.file);
		if (!stats.isFile())
			throw new Error(`artifact output is not a file: ${publication.file}`);
		const digest = fileDigest(publication.file);
		const blob = artifactBlobPath(root, digest);
		if (!validBlob(blob, digest, stats.size)) {
			rmSync(blob, { force: true });
			publishFileAtomically(publication.file, blob);
			if (!validBlob(blob, digest, stats.size)) {
				throw new Error(`artifact blob publication failed: ${blob}`);
			}
		}
		return {
			name: publication.name,
			digest,
			size: stats.size,
			mode: publication.mode ?? stats.mode & 0o777,
		};
	});
	const manifest: ArtifactActionManifest = {
		schema: ACTION_SCHEMA,
		stage,
		producer,
		action,
		maligatorVersion: MALIGATOR_VERSION,
		createdAt: Date.now(),
		outputs,
	};
	publishTextAtomically(
		`${JSON.stringify(manifest)}\n`,
		actionManifestPath(root, stage, producer, action),
	);
	const published = readArtifactAction(root, stage, producer, action);
	if (published === undefined)
		throw new Error(`artifact action publication failed: ${action}`);
	return published;
}

export function artifactOutput(action: ArtifactAction, name: string): ArtifactOutput {
	const output = action.outputs.find((candidate) => candidate.name === name);
	if (output === undefined) throw new Error(`artifact action has no ${name} output`);
	return output;
}

export function materializeArtifact(output: ArtifactOutput, destination: string): void {
	mkdirSync(path.dirname(destination), { recursive: true });
	const temporary = path.join(
		path.dirname(destination),
		`.materialize-${process.pid}-${randomUUID()}`,
	);
	try {
		copyFileSync(output.path, temporary);
		chmodSync(temporary, output.mode);
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

interface ActionLockOwner {
	pid: number;
	createdAt: number;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function withArtifactActionLock<T>(
	root: string,
	stage: string,
	producer: string,
	action: string,
	build: () => T,
	timeoutMs = 10 * 60 * 1000,
): T {
	const manifest = actionManifestPath(root, stage, producer, action);
	const lock = path.join(
		root,
		"locks",
		path.relative(path.join(root, "actions"), manifest),
	);
	const startedAt = Date.now();
	mkdirSync(path.dirname(lock), { recursive: true });
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(
				path.join(lock, "owner.json"),
				`${JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies ActionLockOwner)}\n`,
			);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = JSON.parse(
					readFileSync(path.join(lock, "owner.json"), "utf8"),
				) as ActionLockOwner;
				if (!Number.isInteger(owner.pid) || !processIsAlive(owner.pid)) {
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
			} catch {
				try {
					if (Date.now() - statSync(lock).mtimeMs < 5_000) {
						Atomics.wait(waitBuffer, 0, 0, 50);
						continue;
					}
				} catch {
					continue;
				}
				rmSync(lock, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 10,
				});
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`timed out waiting for artifact action ${stage}:${action}`);
			}
			Atomics.wait(waitBuffer, 0, 0, 50);
		}
	}
	try {
		return build();
	} finally {
		rmSync(lock, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 10,
		});
	}
}

export function artifactStoreExists(root: string): boolean {
	return existsSync(path.join(root, "actions")) || existsSync(path.join(root, "blobs"));
}
