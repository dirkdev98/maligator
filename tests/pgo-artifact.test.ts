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
import {
	finalizeProfileCapture,
	profileCaptureIdentity,
} from "../src/profile-artifact.ts";
import type { PreparedProfile } from "../src/profile-artifact.ts";
import { canonicalProfileJson } from "../src/source-profile-identity.ts";

const directories: Array<string> = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(semanticKey = "a".repeat(64)) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pgo-format-"));
	directories.push(root);
	const prepared: PreparedPgo = {
		schema: 2,
		semantics: 2,
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
			targetInstrumented: instrumented,
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
	target?: { functionIndex: number; count: bigint },
) {
	const capture = createPgoCapture(prepared, "fixture", root);
	const bytes = Buffer.alloc(64 + counts.length * 8 + 2 * 52);
	bytes.write("MALPGO2\0");
	bytes.writeUInt32LE(2, 8);
	bytes.writeUInt32LE(2, 12);
	bytes.writeUInt32LE(1, 16);
	bytes.writeUInt32LE(2, 20);
	bytes.writeUInt32LE(flags, 24);
	bytes.writeUInt32LE(4, 28);
	Buffer.from(capture.manifest.captureIdentity, "hex").copy(bytes, 32);
	counts.forEach((count, index) => bytes.writeBigUInt64LE(count, 64 + index * 8));
	for (let site = 0; site < 2; site++)
		for (let slot = 0; slot < 4; slot++)
			bytes.writeUInt32LE(
				0xffff_ffff,
				64 + counts.length * 8 + site * 52 + 4 + slot * 12,
			);
	if (target !== undefined) {
		bytes.writeUInt32LE(target.functionIndex, 64 + counts.length * 8 + 4);
		bytes.writeBigUInt64LE(target.count, 64 + counts.length * 8 + 8);
	}
	writeFileSync(path.join(capture.directory, "counts.bin"), bytes);
	return { capture, bytes };
}
function cpuRecord(
	root: string,
	semanticKey: string,
	intervalUs: number,
	samples = 24,
	workloadSucceeded = true,
	options: {
		attribution?: "physical" | "inline" | "shared" | "ambiguous";
		dropped?: number;
		delayNs?: bigint;
	} = {},
) {
	const directory = mkdtempSync(path.join(root, "cpu-"));
	const prepared: PreparedProfile = {
		schema: 6,
		calls: [],
		mode: "sampling",
		buildId: "b".repeat(64),
		pgoCompatibility: {
			semanticKey,
			producer: "sampling-test",
			optimization: "full",
		},
		entrypoint: "/project/input.js",
		functions: [
			{
				name: "f",
				file: "input.js",
				identity:
					options.attribution === "ambiguous"
						? { status: "ambiguous", reason: "fixture" }
						: {
								status: options.attribution === "shared" ? "shared" : "known",
								origin: "c".repeat(64),
								revision: "d".repeat(64),
								portability: "portable",
							},
			},
			...(options.attribution === "inline"
				? [
						{
							name: "inlined",
							file: "input.js",
							identity: {
								status: "known" as const,
								origin: "e".repeat(64),
								revision: "f".repeat(64),
								portability: "portable" as const,
							},
						},
					]
				: []),
		],
		sites:
			options.attribution === "inline"
				? [
						{
							id: 0,
							logicalId: "inline-site",
							originId: "inline-origin",
							instanceId: "inline-instance",
							regionId: "inline-region",
							functionIndex: 0,
							instructionIndex: 0,
							positionId: 5,
							file: "input.js",
							line: 1,
							column: 1,
							operation: "call",
							inlineChain: [
								{ functionIndex: 1, positionId: 5 },
								{ functionIndex: 0, positionId: 4 },
							],
						},
					]
				: [],
		remarks: [],
	};
	prepared.captureIdentity = profileCaptureIdentity(prepared);
	const bytes = Buffer.alloc(80 + samples * 40 + samples * 12);
	bytes.write("MALPROF5");
	bytes.writeUInt32LE(5, 8);
	bytes.writeUInt32LE(samples, 12);
	bytes.writeUInt32LE(samples, 16);
	bytes.writeUInt32LE(options.dropped ?? 0, 20);
	bytes.writeUInt32LE(intervalUs, 28);
	Buffer.from(prepared.captureIdentity, "hex").copy(bytes, 48);
	for (let index = 0; index < samples; index++) {
		const offset = 80 + index * 40;
		bytes.writeUInt8(1, offset);
		bytes.writeBigUInt64LE(BigInt(index + 1) * BigInt(intervalUs) * 1_000n, offset + 8);
		bytes.writeBigUInt64LE(options.delayNs ?? 0n, offset + 24);
		bytes.writeUInt32LE(index, offset + 32);
		bytes.writeUInt32LE(1, offset + 36);
		const frame = 80 + samples * 40 + index * 12;
		bytes.writeInt32LE(0, frame);
		bytes.writeInt32LE(-1, frame + 4);
		bytes.writeInt32LE(options.attribution === "inline" ? 0 : -1, frame + 8);
	}
	writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(prepared));
	writeFileSync(path.join(directory, "capture.bin"), bytes);
	finalizeProfileCapture(directory, prepared, "run", { workloadSucceeded });
	return { directory, bytes };
}

it("merges validated CPU captures by exact revision and sampling interval", () => {
	const { root, prepared } = setup();
	const counter = record(prepared, root);
	finalizePgoCapture(counter.capture, true);
	const first = cpuRecord(root, prepared.semanticKey, 10_000);
	const second = cpuRecord(root, prepared.semanticKey, 20_000);
	const merged = mergePgoCaptures(
		[counter.capture.directory],
		path.join(root, "cpu-merged.json"),
		{
			cpuProfiles: [
				{ workload: "first", directory: first.directory },
				{ workload: "second", directory: second.directory },
				{ workload: "first", directory: first.directory },
			],
		},
	);
	expect(merged.profile.cpuCaptures).toHaveLength(2);
	expect(merged.profile.cpuFunctions).toEqual([
		{
			origin: "c".repeat(64),
			revision: "d".repeat(64),
			samples: "48",
			estimatedCpuNs: "720000000",
		},
	]);
	expect(readPgoProfile(merged.path, prepared.semanticKey).cpuFunctions).toEqual(
		merged.profile.cpuFunctions,
	);
	first.bytes[90] = first.bytes[90]! ^ 1;
	writeFileSync(path.join(first.directory, "capture.bin"), first.bytes);
	expect(() =>
		mergePgoCaptures([counter.capture.directory], undefined, {
			cpuProfiles: [{ workload: "first", directory: first.directory }],
		}),
	).toThrow(/checksum/);
});

it("rejects CPU evidence with too few samples even if other profile evidence exists", () => {
	const { root, prepared } = setup();
	const counter = record(prepared, root);
	finalizePgoCapture(counter.capture, true);
	const sparse = cpuRecord(root, prepared.semanticKey, 10_000, 19);
	expect(() =>
		mergePgoCaptures([counter.capture.directory], undefined, {
			cpuProfiles: [{ workload: "sparse", directory: sparse.directory }],
		}),
	).toThrow(/insufficient/);
});

it("rejects interrupted captures and CPU costs inconsistent with recorded intervals", () => {
	const { root, prepared } = setup();
	const counter = record(prepared, root);
	finalizePgoCapture(counter.capture, true);
	const interrupted = cpuRecord(root, prepared.semanticKey, 10_000, 24, false);
	expect(() =>
		mergePgoCaptures([counter.capture.directory], undefined, {
			cpuProfiles: [{ workload: "interrupted", directory: interrupted.directory }],
		}),
	).toThrow(/completed/);
	const completed = cpuRecord(root, prepared.semanticKey, 10_000);
	const merged = mergePgoCaptures(
		[counter.capture.directory],
		path.join(root, "cost.json"),
		{
			cpuProfiles: [{ workload: "completed", directory: completed.directory }],
		},
	);
	const malformed = {
		...merged.profile,
		cpuFunctions: merged.profile.cpuFunctions.map((row) => ({
			...row,
			estimatedCpuNs: "0",
		})),
	};
	const { digest: _digest, ...contents } = malformed;
	malformed.digest = hash("sha256", canonicalProfileJson(contents), "hex");
	const file = path.join(root, "malformed.json");
	writeFileSync(file, JSON.stringify(malformed));
	expect(() => readPgoProfile(file, prepared.semanticKey)).toThrow(/CPU function row/);
});

it("attributes an inlined sample to its source leaf and excludes ambiguous identities", () => {
	const { root, prepared } = setup();
	const counter = record(prepared, root);
	finalizePgoCapture(counter.capture, true);
	const inline = cpuRecord(root, prepared.semanticKey, 10_000, 24, true, {
		attribution: "inline",
	});
	const shared = cpuRecord(root, prepared.semanticKey, 10_000, 24, true, {
		attribution: "shared",
	});
	const ambiguous = cpuRecord(root, prepared.semanticKey, 10_000, 24, true, {
		attribution: "ambiguous",
	});
	const merged = mergePgoCaptures(
		[counter.capture.directory],
		path.join(root, "inline.json"),
		{
			cpuProfiles: [
				{ workload: "inline", directory: inline.directory },
				{ workload: "shared", directory: shared.directory },
				{ workload: "ambiguous", directory: ambiguous.directory },
			],
		},
	);
	expect(merged.profile.cpuFunctions).toEqual([
		{
			origin: "e".repeat(64),
			revision: "f".repeat(64),
			samples: "24",
			estimatedCpuNs: "240000000",
		},
	]);
	expect(
		merged.profile.cpuCaptures.map((capture) => capture.ambiguousSamples).sort(),
	).toEqual([0, 24, 24]);
});

it("rejects dropped and delayed CPU samples before they can guide optimization", () => {
	const { root, prepared } = setup();
	const counter = record(prepared, root);
	finalizePgoCapture(counter.capture, true);
	for (const options of [{ dropped: 1 }, { delayNs: 50_000_000n }]) {
		const bad = cpuRecord(root, prepared.semanticKey, 10_000, 24, true, options);
		expect(() =>
			mergePgoCaptures([counter.capture.directory], undefined, {
				cpuProfiles: [{ workload: "bad", directory: bad.directory }],
			}),
		).toThrow(/dropped|delayed/);
	}
});
it("merges exact target guard matches and keeps an incomplete site unknown", () => {
	const { root, prepared } = setup();
	const first = record(prepared, root, [3n, 3n, 0n], 0, {
		functionIndex: 0,
		count: 2n,
	});
	const second = record(prepared, root, [2n, 2n, 0n], 0, {
		functionIndex: 0,
		count: 1n,
	});
	finalizePgoCapture(first.capture, true);
	finalizePgoCapture(second.capture, true);
	const merged = mergePgoCaptures(
		[first.capture.directory, second.capture.directory],
		path.join(root, "targets.json"),
	);
	expect(merged.profile.targets).toEqual([
		{
			key: "e".repeat(64),
			origin: "c".repeat(64),
			revision: "d".repeat(64),
			count: "3",
		},
	]);
	expect(merged.profile.targetUnknownCalls).toEqual([]);
	const truncated = record(prepared, root, [0n, 1n, 0n]);
	truncated.bytes.writeUInt32LE(1, 64 + 3 * 8);
	writeFileSync(path.join(truncated.capture.directory, "counts.bin"), truncated.bytes);
	finalizePgoCapture(truncated.capture, true);
	const incomplete = mergePgoCaptures(
		[first.capture.directory, truncated.capture.directory],
		path.join(root, "incomplete.json"),
	);
	expect(incomplete.profile.targetUnknownCalls).toEqual(["e".repeat(64)]);
});
it("rejects old and malformed target tables", () => {
	const { root, prepared } = setup();
	const { bytes } = record(prepared, root, [1n, 1n, 0n], 0, {
		functionIndex: 0,
		count: 1n,
	});
	const duplicate = Buffer.from(bytes);
	duplicate.writeUInt32LE(0, 64 + 3 * 8 + 4 + 12);
	duplicate.writeBigUInt64LE(1n, 64 + 3 * 8 + 8 + 12);
	expect(() => parsePgoCounts(duplicate)).toThrow(/duplicate/);
	const old = Buffer.from(bytes);
	old.write("MALPGO1\0");
	expect(() => parsePgoCounts(old)).toThrow(/schema/);
});
it("accepts saturated target sums while retaining overflow", () => {
	const { root, prepared } = setup();
	prepared.functions.push({
		name: "other",
		generator: false,
		identity: {
			status: "known",
			origin: "1".repeat(64),
			revision: "2".repeat(64),
			portability: "portable",
		},
	});
	const capture = createPgoCapture(prepared, "overflow", root);
	const bytes = Buffer.alloc(64 + 4 * 8 + 2 * 52);
	bytes.write("MALPGO2\0");
	bytes.writeUInt32LE(2, 8);
	bytes.writeUInt32LE(2, 12);
	bytes.writeUInt32LE(2, 16);
	bytes.writeUInt32LE(2, 20);
	bytes.writeUInt32LE(1, 24);
	bytes.writeUInt32LE(4, 28);
	Buffer.from(capture.manifest.captureIdentity, "hex").copy(bytes, 32);
	bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 64 + 2 * 8);
	for (let site = 0; site < 2; site++)
		for (let slot = 0; slot < 4; slot++)
			bytes.writeUInt32LE(0xffff_ffff, 64 + 4 * 8 + site * 52 + 4 + slot * 12);
	for (let slot = 0; slot < 2; slot++) {
		bytes.writeUInt32LE(slot, 64 + 4 * 8 + 4 + slot * 12);
		bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 64 + 4 * 8 + 8 + slot * 12);
	}
	expect(parsePgoCounts(bytes).overflow).toBe(true);
	writeFileSync(path.join(capture.directory, "counts.bin"), bytes);
	expect(finalizePgoCapture(capture, true).overflow).toBe(true);
});
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
