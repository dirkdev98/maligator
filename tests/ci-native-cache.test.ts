import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportSnapshot, importSnapshot } from "../scripts/ci-native-cache.ts";

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
		exportSnapshot(snapshot, root, 300);

		expect(existsSync(path.join(snapshot, rust))).toBe(true);
		expect(existsSync(path.join(snapshot, overlay))).toBe(true);
		expect(existsSync(path.join(snapshot, newest))).toBe(true);
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
});
