import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import {
	finalizeProfileCapture,
	formatProfileReport,
	parseCompilerCapture,
	parseProfileCapture,
} from "../src/profile-artifact.ts";
import type { PreparedProfile } from "../src/profile-artifact.ts";

function capture(): Uint8Array {
	const bytes = new Uint8Array(48 + 2 * 40 + 2 * 12);
	bytes.set(Buffer.from("MALPROF3"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 3, true);
	view.setUint32(12, 2, true);
	view.setUint32(16, 2, true);
	view.setUint32(28, 10_000, true);
	view.setBigUint64(32, 123n, true);
	view.setBigUint64(40, 65_536n, true);
	view.setUint8(48, 1);
	view.setBigUint64(56, 10_000_000n, true);
	view.setBigUint64(72, 1_000_000n, true);
	view.setUint32(80, 0, true);
	view.setUint32(84, 1, true);
	view.setUint8(88, 2);
	view.setUint8(89, 2);
	view.setUint8(90, 3);
	view.setUint8(91, 0xff);
	view.setBigUint64(96, 20_000_000n, true);
	view.setBigUint64(104, 64n, true);
	view.setBigUint64(112, 80n, true);
	view.setUint32(120, 1, true);
	view.setUint32(124, 1, true);
	view.setInt32(128, 0, true);
	view.setInt32(132, 5, true);
	view.setInt32(136, 1, true);
	view.setInt32(140, 0, true);
	view.setInt32(144, 5, true);
	view.setInt32(148, 1, true);
	return bytes;
}

function compilerCapture(): Uint8Array {
	const bytes = new Uint8Array(32 + 8 * 8 + 2 * 8 * 8 + 32);
	bytes.set(Buffer.from("MALSITE2"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 2, true);
	view.setUint32(12, 2, true);
	view.setUint32(16, 2, true);
	view.setUint32(20, 8, true);
	view.setUint32(24, 1, true);
	const sites = 32 + 8 * 8;
	view.setBigUint64(sites + 8, 10n, true);
	view.setBigUint64(sites + 3 * 8, 2n, true);
	view.setBigUint64(sites + 5 * 8, 5n, true);
	view.setBigUint64(sites + 7 * 8, 128n, true);
	view.setBigUint64(sites + 9 * 8, 160n, true);
	const allocation = sites + 2 * 8 * 8;
	view.setInt32(allocation, 1, true);
	view.setUint8(allocation + 4, 2);
	view.setUint8(allocation + 5, 3);
	view.setUint8(allocation + 6, 0xff);
	view.setBigUint64(allocation + 8, 5n, true);
	view.setBigUint64(allocation + 16, 128n, true);
	view.setBigUint64(allocation + 24, 160n, true);
	return bytes;
}

function legacyCapture(): Uint8Array {
	const bytes = new Uint8Array(40 + 40 + 8);
	bytes.set(Buffer.from("MALPROF1"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 1, true);
	view.setUint32(12, 1, true);
	view.setUint32(16, 1, true);
	view.setUint32(28, 10_000, true);
	view.setUint8(40, 1);
	view.setUint32(72, 0, true);
	view.setUint32(76, 1, true);
	view.setInt32(80, 0, true);
	view.setInt32(84, 5, true);
	return bytes;
}

function legacyV2Capture(): Uint8Array {
	const bytes = new Uint8Array(40 + 40 + 12);
	bytes.set(Buffer.from("MALPROF2"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 2, true);
	view.setUint32(12, 1, true);
	view.setUint32(16, 1, true);
	view.setUint32(28, 10_000, true);
	view.setUint8(40, 1);
	view.setUint32(72, 0, true);
	view.setUint32(76, 1, true);
	view.setInt32(80, 0, true);
	view.setInt32(84, 5, true);
	view.setInt32(88, 1, true);
	return bytes;
}

const prepared: PreparedProfile = {
	schema: 2,
	mode: "sampling",
	buildId: "a".repeat(64),
	entrypoint: "/project/app.js",
	functions: [{ name: "hot", file: "app.js" }],
	sites: [
		{
			id: 0,
			logicalId: "site-v1-hot",
			originId: "site-v1-hot-origin",
			instanceId: "site-v1-hot",
			regionId: "site-v1-main",
			functionIndex: 0,
			instructionIndex: 0,
			positionId: 5,
			file: "app.js",
			line: 7,
			column: 2,
			operation: "execute",
			inlineChain: [{ functionIndex: 0, positionId: 5 }],
		},
		{
			id: 1,
			logicalId: "site-v1-property",
			originId: "site-v1-property-origin",
			instanceId: "site-v1-property",
			regionId: "site-v1-main",
			functionIndex: 0,
			instructionIndex: 1,
			positionId: 5,
			file: "app.js",
			line: 7,
			column: 2,
			operation: "property",
			inlineChain: [{ functionIndex: 0, positionId: 5 }],
		},
	],
	remarks: [
		{
			siteId: 1,
			phase: "lowering",
			operation: "property",
			code: "property.dynamic-load",
			outcome: "retained",
		},
	],
};

test("profile capture parser rejects truncation and invalid frame references", () => {
	expect(() => parseProfileCapture(capture().subarray(0, 39))).toThrow("truncated");
	const invalid = capture();
	new DataView(invalid.buffer).setUint32(80, 99, true);
	expect(() => parseProfileCapture(invalid)).toThrow("outside");
});

test("profile capture reports per-record stack truncation and physical allocation kind", () => {
	const bytes = capture();
	new DataView(bytes.buffer).setUint32(52, 0x8000_0003, true);
	const parsed = parseProfileCapture(bytes);
	expect(parsed.records[0]).toMatchObject({
		omittedFrames: 3,
		depthTruncated: true,
		capacityTruncated: false,
	});
	expect(parsed.records[1]).toMatchObject({
		allocationStorage: 2,
		allocationFamily: 3,
		value: 64,
		auxiliary: 80,
	});
});

test("legacy captures never guess between same-position operations", () => {
	const parsed = parseProfileCapture(legacyCapture());
	expect(parsed.records[0]?.frames[0]?.siteId).toBe(-1);
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-legacy-"));
	writeFileSync(path.join(directory, "capture.bin"), legacyCapture());
	expect(finalizeProfileCapture(directory, prepared, "run").findings).toEqual([]);
});

test("schema-two captures retain exact legacy site IDs", () => {
	const parsed = parseProfileCapture(legacyV2Capture());
	expect(parsed).toMatchObject({
		schema: 2,
		allocationSampling: "legacy-fixed",
		samplingClock: "legacy-mixed",
	});
	expect(parsed.records[0]?.frames[0]?.siteId).toBe(1);
});

test("compiler counter parser validates its independent schema", () => {
	expect(() => parseCompilerCapture(compilerCapture().subarray(0, 23))).toThrow(
		"truncated",
	);
	const parsed = parseCompilerCapture(compilerCapture());
	expect(parsed.bySite[1]).toMatchObject({
		executions: 10,
		fastPaths: 0,
		fallbacks: 2,
		allocationRequestedBytes: 128,
		allocationChargedBytes: 160,
	});
	expect(parsed.allocations[0]).toMatchObject({
		siteId: 1,
		family: 3,
		count: 5,
		chargedBytes: 160,
	});
});

test("profile finalization publishes standard views and joins remarks by source site", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-artifact-"));
	writeFileSync(path.join(directory, "capture.bin"), capture());
	writeFileSync(path.join(directory, "capture.bin.compiler"), compilerCapture());
	const result = finalizeProfileCapture(directory, prepared, "run");

	expect(result.findings[0]).toMatchObject({
		cpuSamples: 1,
		allocationSamples: 1,
		sampledChargedBytes: 80,
		allocationFamilies: [{ family: "array", storage: "raw-payload" }],
		remarks: ["property.dynamic-load"],
		compiler: { executions: 10, fastPaths: 0, fallbacks: 2 },
	});
	expect(existsSync(path.join(directory, "cpu.cpuprofile"))).toBe(true);
	expect(existsSync(path.join(directory, "timeline.json"))).toBe(true);
	expect(existsSync(path.join(directory, "manifest.json"))).toBe(true);
	expect(existsSync(path.join(directory, "compiler.json"))).toBe(true);
	const profile = JSON.parse(
		readFileSync(path.join(directory, "cpu.cpuprofile"), "utf-8"),
	) as { samples: Array<unknown> };
	expect(profile.samples).toHaveLength(1);
	const manifest = JSON.parse(
		readFileSync(path.join(directory, "manifest.json"), "utf-8"),
	) as {
		status: string;
		cpuSamples: number;
		allocationSamples: number;
		clocks: { sampling: string };
	};
	expect(manifest).toMatchObject({
		status: "complete",
		cpuSamples: 1,
		allocationSamples: 1,
		clocks: { sampling: "process-cpu" },
	});
	expect(result.manifest.compiler).toMatchObject({
		allocationCount: 5,
		requestedBytes: 128,
		chargedBytes: 160,
	});
	const report = formatProfileReport(result).join("\n");
	expect(report).toContain("Sampling 10.00 ms process-cpu CPU / 64 KiB poisson");
	expect(report).toContain("GC 0 collections");
	expect(report).toContain("estimated charged allocation traffic");
	expect(report).toContain("Exact allocation families array/raw-payload 160 B");
	expect(report).toContain("Compiler coverage 2/2 sites (100.0%)");
});
