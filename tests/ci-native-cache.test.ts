import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	exportSnapshot,
	importSnapshot,
	snapshotContents,
} from "../scripts/ci-native-cache.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "mal-ci-native-cache-"));
	vi.stubEnv("GITHUB_OUTPUT", "");
	vi.stubEnv("GITHUB_ENV", "");
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

function blobPath(root: string, digest: string): string {
	return path.join(root, "blobs", "sha256", digest.slice(0, 2), digest.slice(2));
}

function publishBake(root: string, key: string, lastUsedMs: number): string {
	const bakeDirectory = path.join(root, "compiler-wire", key.repeat(64));
	mkdirSync(bakeDirectory, { recursive: true });
	writeFileSync(path.join(bakeDirectory, "compiler.malw"), `wire ${key}`);
	writeFileSync(path.join(bakeDirectory, "artifact.json"), `{"key":"${key}"}`);
	const lastUse = new Date(lastUsedMs);
	utimesSync(path.join(bakeDirectory, "artifact.json"), lastUse, lastUse);
	return path.join("compiler-wire", key.repeat(64));
}

/** Publishes one single-output action the way the artifact store lays it out. */
function publishAction(
	root: string,
	stage: string,
	name: string,
	bytes: number,
	lastUsedMs: number,
): string {
	const content = Buffer.alloc(bytes, name);
	const digest = createHash("sha256").update(content).digest("hex");
	mkdirSync(path.dirname(blobPath(root, digest)), { recursive: true });
	writeFileSync(blobPath(root, digest), content);
	const manifest = path.join("actions", stage, "producer", `${name}.json`);
	mkdirSync(path.dirname(path.join(root, manifest)), { recursive: true });
	writeFileSync(
		path.join(root, manifest),
		JSON.stringify({ outputs: [{ name: "object.o", digest, size: bytes, mode: 420 }] }),
	);
	const lastUse = new Date(lastUsedMs);
	utimesSync(path.join(root, manifest), lastUse, lastUse);
	return manifest;
}

describe("CI native cache snapshots", () => {
	it("keeps costlier stages ahead of newer fixture objects within the cap", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const rust = publishAction(root, "rust-library", "rust", 100, now - 3_000);
		const overlay = publishAction(
			root,
			"compiler-overlay-object",
			"overlay",
			100,
			now - 2_000,
		);
		const newest = publishAction(root, "generated-object", "newest", 100, now);
		const older = publishAction(root, "generated-object", "older", 100, now - 1_000);

		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, root, { maxBytes: 300 });

		expect(existsSync(path.join(snapshot, rust))).toBe(true);
		expect(existsSync(path.join(snapshot, overlay))).toBe(true);
		expect(existsSync(path.join(snapshot, newest))).toBe(true);
		expect(existsSync(path.join(snapshot, older))).toBe(false);
	});

	it("keeps what this job read, then ThinLTO entries, ahead of older actions", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const importedAt = now - 10_000;
		const read = publishAction(root, "generated-object", "read", 100, now);
		const older = publishAction(root, "rust-library", "older", 100, importedAt - 1_000);
		const thinLto = path.join(root, "thinlto", "0123abcd", "llvmcache-entry");
		mkdirSync(path.dirname(thinLto), { recursive: true });
		writeFileSync(thinLto, Buffer.alloc(100, "t"));

		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, root, { maxBytes: 200, usedSinceMs: importedAt });

		expect(existsSync(path.join(snapshot, read))).toBe(true);
		expect(
			existsSync(path.join(snapshot, "thinlto", "0123abcd", "llvmcache-entry")),
		).toBe(true);
		expect(existsSync(path.join(snapshot, older))).toBe(false);
	});

	it("carries only listed stages read within the retention window", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const runtime = publishAction(root, "runtime-object", "runtime", 10, now);
		const stale = publishAction(root, "runtime-object", "stale", 10, now - 15 * DAY_MS);
		const binary = publishAction(root, "linked-binary", "binary", 10, now);

		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, root);

		expect(existsSync(path.join(snapshot, runtime))).toBe(true);
		expect(existsSync(path.join(snapshot, stale))).toBe(false);
		expect(existsSync(path.join(snapshot, binary))).toBe(false);
	});

	it("carries ThinLTO entries after actions and restores only intact ones", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const action = publishAction(root, "rust-library", "rust", 100, now);
		const thinLto = (name: string, bytes: number, lastUsedMs: number) => {
			const file = path.join(root, "thinlto", "0123abcd", `llvmcache-${name}`);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, Buffer.alloc(bytes, name));
			const lastUse = new Date(lastUsedMs);
			utimesSync(file, lastUse, lastUse);
			return path.join("thinlto", "0123abcd", `llvmcache-${name}`);
		};
		const newest = thinLto("newest", 50, now - 1_000);
		const intact = thinLto("intact", 50, now - 2_000);
		const dropped = thinLto("dropped", 50, now - 3_000);

		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, root, { maxBytes: 200 });
		expect(existsSync(path.join(snapshot, action))).toBe(true);
		expect(existsSync(path.join(snapshot, dropped))).toBe(false);
		writeFileSync(path.join(snapshot, newest), "tampered");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const restored = path.join(directory, "restored");
		importSnapshot(snapshot, restored);
		expect(existsSync(path.join(restored, newest))).toBe(false);
		expect(statSync(path.join(restored, intact)).mtimeMs).toBe(now - 2_000);
	});

	it("carries the compiler bakes this job used and restores only intact ones", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const bake = (key: string, lastUsedMs: number) => {
			const bakeDirectory = path.join(root, "compiler-wire", key.repeat(64));
			mkdirSync(bakeDirectory, { recursive: true });
			writeFileSync(path.join(bakeDirectory, "compiler.malw"), `wire ${key}`);
			writeFileSync(path.join(bakeDirectory, "compiler-native-overlay-table.c"), key);
			writeFileSync(path.join(bakeDirectory, "artifact.json"), `{"key":"${key}"}`);
			const lastUse = new Date(lastUsedMs);
			utimesSync(path.join(bakeDirectory, "artifact.json"), lastUse, lastUse);
			return path.join("compiler-wire", key.repeat(64));
		};
		const used = bake("a", now - 1_000);
		const tampered = bake("b", now - 2_000);
		const unused = bake("c", now - DAY_MS);
		mkdirSync(path.join(root, "compiler-wire", ".source-cones"), { recursive: true });

		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, root, { usedSinceMs: now - 10_000 });
		expect(existsSync(path.join(snapshot, unused))).toBe(false);
		expect(existsSync(path.join(snapshot, "compiler-wire", ".source-cones"))).toBe(false);
		writeFileSync(path.join(snapshot, tampered, "compiler.malw"), "tampered");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const restored = path.join(directory, "restored");
		importSnapshot(snapshot, restored);
		expect(readFileSync(path.join(restored, used, "compiler.malw"), "utf8")).toBe(
			"wire a",
		);
		expect(statSync(path.join(restored, used, "artifact.json")).mtimeMs).toBe(
			now - 1_000,
		);
		expect(existsSync(path.join(restored, tampered))).toBe(false);
	});

	it("restores verified actions with their last-use time and skips corrupt blobs", () => {
		const source = path.join(directory, "source");
		const lastUsedMs = Date.now() - DAY_MS;
		const kept = publishAction(source, "generated-object", "kept", 20, lastUsedMs);
		const corrupt = publishAction(source, "generated-object", "corrupt", 20, lastUsedMs);
		const snapshot = path.join(directory, "snapshot");
		exportSnapshot(snapshot, source);
		const corruptDigest = createHash("sha256")
			.update(Buffer.alloc(20, "corrupt"))
			.digest("hex");
		writeFileSync(blobPath(snapshot, corruptDigest), "tampered");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const restored = path.join(directory, "restored");
		importSnapshot(snapshot, restored);

		expect(statSync(path.join(restored, kept)).mtimeMs).toBe(lastUsedMs);
		expect(existsSync(path.join(restored, corrupt))).toBe(false);
		expect(existsSync(blobPath(restored, corruptDigest))).toBe(false);
	});

	it("keeps only a lane's shared stages and bakes in its shared snapshot", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		const rust = publishAction(root, "rust-library", "rust", 10, now - DAY_MS);
		const archive = publishAction(root, "runtime-archive", "archive", 10, now);
		const fixture = publishAction(root, "generated-object", "fixture", 10, now);
		const bake = publishBake(root, "a", now - DAY_MS);

		const shared = path.join(directory, "shared");
		exportSnapshot(shared, root, { part: "shared", usedSinceMs: now - 1_000 });

		expect(snapshotContents(shared)).toEqual(new Set([rust, archive, bake]));
		expect(existsSync(path.join(shared, fixture))).toBe(false);
	});

	it("leaves what the restored shared snapshot holds out of a job line", () => {
		const now = Date.now();
		const owner = path.join(directory, "owner");
		const common = publishAction(owner, "runtime-archive", "common", 10, now);
		const commonBake = publishBake(owner, "a", now);
		const shared = path.join(directory, "shared");
		exportSnapshot(shared, owner, { part: "shared" });

		const root = path.join(directory, "cache");
		importSnapshot(shared, root, "shared");
		const variant = publishAction(root, "runtime-archive", "sanitized", 10, now);
		const variantBake = publishBake(root, "b", now);
		const fixture = publishAction(root, "generated-object", "fixture", 10, now);

		const line = path.join(directory, "line");
		exportSnapshot(line, root, { withoutShared: snapshotContents(shared) });

		expect(snapshotContents(line)).toEqual(new Set([variant, variantBake, fixture]));
		expect(existsSync(path.join(line, common))).toBe(false);
		expect(existsSync(path.join(line, commonBake))).toBe(false);
	});

	it("leaves every shared stage out of the line of the job that saves the shared snapshot", () => {
		const root = path.join(directory, "cache");
		const now = Date.now();
		publishAction(root, "rust-library", "rust", 10, now);
		publishBake(root, "a", now);
		const fixture = publishAction(root, "generated-object", "fixture", 10, now);

		const line = path.join(directory, "line");
		exportSnapshot(line, root, { withoutShared: "all" });

		expect(snapshotContents(line)).toEqual(new Set([fixture]));
	});

	it("reports a restored shared snapshot apart from the job line", () => {
		const source = path.join(directory, "source");
		publishAction(source, "runtime-archive", "archive", 10, Date.now());
		const shared = path.join(directory, "shared");
		exportSnapshot(shared, source, { part: "shared" });
		const environment = path.join(directory, "github-env");
		vi.stubEnv("GITHUB_ENV", environment);

		importSnapshot(shared, path.join(directory, "cache"), "shared");

		const recorded = readFileSync(environment, "utf8");
		expect(recorded).toMatch(/^MALIGATOR_NATIVE_SHARED_RESTORED=[0-9a-f]{64}$/m);
		expect(recorded).not.toMatch(/^MALIGATOR_NATIVE_CACHE_RESTORED=/m);
	});
});
