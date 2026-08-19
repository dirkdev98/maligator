import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
		writeFileSync(destination, "mutated output");

		const restored = readArtifactAction(root, "example", producer, action);
		expect(restored).toBeDefined();
		expect(readFileSync(artifactOutput(restored!, "binary").path, "utf8")).toBe(
			"cached bytes",
		);
	});

	it("rejects corruption and allows the action to be rebuilt", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "maligator-corrupt-"));
		const source = path.join(root, "source");
		writeFileSync(source, "good");
		const producer = artifactProducer("example", 1, "implementation");
		const action = artifactActionKey(producer, { input: "corrupt" });
		const published = publishArtifactAction(root, "example", producer, action, [
			{ name: "object", file: source },
		]);
		writeFileSync(artifactOutput(published, "object").path, "evil");
		expect(readArtifactAction(root, "example", producer, action)).toBeUndefined();
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
