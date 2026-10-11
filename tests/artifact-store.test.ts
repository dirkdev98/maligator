import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	artifactActionKey,
	artifactOutput,
	artifactProducer,
	materializeArtifact,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "../src/artifact-store.ts";

describe("layered artifact store", () => {
	it("publishes immutable blobs and materializes independent outputs", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "maligator-artifacts-"));
		const source = path.join(root, "source");
		writeFileSync(source, "cached bytes");
		chmodSync(source, 0o755);
		const producer = artifactProducer("example", 1, "implementation");
		const action = artifactActionKey(producer, { input: "same" });
		const published = publishArtifactAction(root, "example", producer, action, [
			{ name: "binary", file: source },
		]);
		const destination = path.join(root, "output", "binary");
		materializeArtifact(artifactOutput(published, "binary"), destination);
		expect(statSync(destination).mode & 0o777).toBe(0o755);
		writeFileSync(source, "mutated source");
		writeFileSync(destination, "mutated output");

		const restored = readArtifactAction(root, "example", producer, action);
		expect(restored).toBeDefined();
		expect(readFileSync(artifactOutput(restored!, "binary").path, "utf8")).toBe(
			"cached bytes",
		);
	});

	it.each(["changed modification time", "restored modification time"])(
		"rejects same-size corruption and rebuilds with %s",
		(timestamps) => {
			const root = mkdtempSync(path.join(os.tmpdir(), "maligator-corrupt-"));
			const source = path.join(root, "source");
			writeFileSync(source, "good");
			const producer = artifactProducer("example", 1, "implementation");
			const action = artifactActionKey(producer, { input: "corrupt" });
			const published = publishArtifactAction(root, "example", producer, action, [
				{ name: "object", file: source },
			]);
			const blob = artifactOutput(published, "object").path;
			const beforeCorruption = statSync(blob);
			writeFileSync(blob, "evil");
			if (timestamps === "restored modification time") {
				utimesSync(blob, beforeCorruption.atime, beforeCorruption.mtime);
			}
			expect(readArtifactAction(root, "example", producer, action)).toBeUndefined();
			expect(existsSync(blob)).toBe(false);

			publishArtifactAction(root, "example", producer, action, [
				{ name: "object", file: source },
			]);
			const rebuilt = readArtifactAction(root, "example", producer, action);
			expect(rebuilt).toBeDefined();
			expect(readFileSync(artifactOutput(rebuilt!, "object").path, "utf8")).toBe("good");
		},
	);

	it.each([
		{
			name: "empty",
			bytes: new Uint8Array(),
			digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		{
			name: "all byte values",
			bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
			digest: "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
		},
	])("preserves the SHA-256 identity of $name files", ({ name, bytes, digest }) => {
		const root = mkdtempSync(path.join(os.tmpdir(), "maligator-binary-artifacts-"));
		try {
			const source = path.join(root, "source");
			writeFileSync(source, bytes);
			const producer = artifactProducer("example", 1, "implementation");
			const action = artifactActionKey(producer, { input: name });
			const published = publishArtifactAction(root, "example", producer, action, [
				{ name: "binary", file: source },
			]);
			const output = artifactOutput(published, "binary");
			expect(output.digest).toBe(digest);
			expect(output.size).toBe(bytes.byteLength);
			expect([...readFileSync(output.path)]).toEqual([...bytes]);
			const restored = readArtifactAction(root, "example", producer, action);
			expect(restored).toBeDefined();
			expect(artifactOutput(restored!, "binary").digest).toBe(digest);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers a stale per-action publication lock", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "maligator-lock-"));
		const producer = artifactProducer("example", 1, "implementation");
		const action = artifactActionKey(producer, "input");
		const result = withArtifactActionLock(root, "example", producer, action, () => 42);
		expect(result).toBe(42);
	});

	it("canonicalizes object key ordering", () => {
		const producer = artifactProducer("example", 1, "implementation");
		expect(artifactActionKey(producer, { a: 1, b: 2 })).toBe(
			artifactActionKey(producer, { b: 2, a: 1 }),
		);
	});
});
