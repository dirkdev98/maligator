import { hash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createPgoCapture,
	finalizePgoCapture,
	mergePgoCaptures,
	parsePgoCounts,
	readPgoProfile,
} from "../src/pgo-artifact.ts";
import type { PreparedPgo } from "../src/pgo-artifact.ts";

const directories: Array<string> = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(semanticKey = "a".repeat(64)) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pgo-format-"));
	directories.push(root);
	const prepared: PreparedPgo = {
		schema: 1,
		semantics: 1,
		producer: "p",
		semanticKey,
		image: "b".repeat(64),
		functions: [
			{
				name: "f",
				generator: false,
				identity: {
					status: "known",
					origin: "c".repeat(64),
					revision: "d".repeat(64),
					portability: "portable",
				},
			},
		],
		calls: [true, false].map((instrumented) => ({
			kind: "call",
			file: "input.js",
			line: 1,
			column: 1,
			instrumented,
			identity: {
				status: "known",
				key: (instrumented ? "e" : "f").repeat(64),
				owner: "c".repeat(64),
				revision: "d".repeat(64),
			},
		})),
	};
	return { root, prepared };
}
function record(
	prepared: PreparedPgo,
	root: string,
	counts: Array<bigint> = [3n, 0n, 0n],
	flags = 0,
) {
	const capture = createPgoCapture(prepared, "fixture", root);
	const bytes = Buffer.alloc(64 + counts.length * 8);
	bytes.write("MALPGO1\0");
	bytes.writeUInt32LE(1, 8);
	bytes.writeUInt32LE(1, 12);
	bytes.writeUInt32LE(1, 16);
	bytes.writeUInt32LE(2, 20);
	bytes.writeUInt32LE(flags, 24);
	Buffer.from(capture.manifest.captureIdentity, "hex").copy(bytes, 32);
	counts.forEach((count, index) => bytes.writeBigUInt64LE(count, 64 + index * 8));
	writeFileSync(path.join(capture.directory, "counts.bin"), bytes);
	return { capture, bytes };
}
it("merges exact u64 counts once per run and distinguishes uninstrumented sites from zero", () => {
	const { root, prepared } = setup();
	const first = record(prepared, root, [9007199254740993n, 0n, 0n]);
	const second = record(prepared, root, [2n, 4n, 0n]);
	finalizePgoCapture(first.capture, true);
	finalizePgoCapture(second.capture, true);
	const a = mergePgoCaptures(
		[first.capture.directory, second.capture.directory, first.capture.directory],
		path.join(root, "a.json"),
	);
	const b = mergePgoCaptures(
		[second.capture.directory, first.capture.directory],
		path.join(root, "b.json"),
	);
	expect(a.profile).toEqual(b.profile);
	expect(a.profile.functions[0]?.count).toBe("9007199254740995");
	expect(a.profile.calls).toHaveLength(1);
	expect(a.profile.calls[0]?.count).toBe("4");
	expect(a.profile.coverage.uninstrumentedCalls).toBe(2);
	expect(readPgoProfile(a.path, prepared.semanticKey)).toEqual(a.profile);
});
it("saturates merges and reports overflow", () => {
	const { root, prepared } = setup();
	const a = record(prepared, root, [0xffffffffffffffffn, 0n, 0n]);
	const b = record(prepared, root);
	finalizePgoCapture(a.capture, true);
	finalizePgoCapture(b.capture, true);
	const merged = mergePgoCaptures(
		[a.capture.directory, b.capture.directory],
		path.join(root, "merged.json"),
	);
	expect(merged.profile.overflow).toBe(true);
	expect(merged.profile.functions[0]?.count).toBe("18446744073709551615");
});
it("rejects partial, invalid, failed and corrupted captures", () => {
	const { root, prepared } = setup();
	const { capture, bytes } = record(prepared, root);
	expect(() => parsePgoCounts(bytes.subarray(0, bytes.length - 1))).toThrow(/length/);
	expect(() => mergePgoCaptures([capture.directory])).toThrow(/incomplete/);
	expect(() => finalizePgoCapture(capture, false)).toThrow(/successfully/);
	finalizePgoCapture(capture, true);
	bytes[64] = 9;
	writeFileSync(path.join(capture.directory, "counts.bin"), bytes);
	expect(() => mergePgoCaptures([capture.directory])).toThrow(/checksum/);
	const invalid = record(prepared, root, [0n, 0n, 0n], 2);
	expect(() => finalizePgoCapture(invalid.capture, true)).toThrow(/unsupported/);
});
it("rejects conflicting duplicates and semantic configurations", () => {
	const { root, prepared } = setup();
	const a = record(prepared, root);
	finalizePgoCapture(a.capture, true);
	const b = record({ ...prepared, semanticKey: "f".repeat(64) }, root);
	finalizePgoCapture(b.capture, true);
	expect(() => mergePgoCaptures([a.capture.directory, b.capture.directory])).toThrow(
		/configuration/,
	);
	const saved = path.join(a.capture.directory, "original.json");
	writeFileSync(saved, readFileSync(path.join(a.capture.directory, "manifest.json")));
	a.bytes[64] = 7;
	writeFileSync(path.join(a.capture.directory, "counts.bin"), a.bytes);
	const changed = {
		...a.capture.manifest,
		status: "complete",
		payloadDigest: hash("sha256", a.bytes, "hex"),
	};
	writeFileSync(path.join(a.capture.directory, "manifest.json"), JSON.stringify(changed));
	expect(() => mergePgoCaptures([saved, a.capture.directory])).toThrow();
});

it("publishes profiles immutably while accepting an identical merge", () => {
	const { root, prepared } = setup();
	const a = record(prepared, root);
	finalizePgoCapture(a.capture, true);
	const output = path.join(root, "selected.json");
	const first = mergePgoCaptures([a.capture.directory], output);
	expect(mergePgoCaptures([a.capture.directory], output).profile.digest).toBe(
		first.profile.digest,
	);
	const b = record(prepared, root);
	finalizePgoCapture(b.capture, true);
	expect(() => mergePgoCaptures([b.capture.directory], output)).toThrow(/immutable/);
	expect(readPgoProfile(output, prepared.semanticKey).digest).toBe(first.profile.digest);
});
