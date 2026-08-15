import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import {
	finalizeProfileCapture,
	parseCompilerCapture,
	parseProfileCapture,
} from "../src/profile-artifact.ts";
import type { PreparedProfile } from "../src/profile-artifact.ts";

function capture(): Uint8Array {
	const bytes = new Uint8Array(40 + 2 * 40 + 2 * 12);
	bytes.set(Buffer.from("MALPROF2"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 2, true);
	view.setUint32(12, 2, true);
	view.setUint32(16, 2, true);
	view.setUint32(28, 10_000, true);
	view.setBigUint64(32, 123n, true);
	view.setUint8(40, 1);
	view.setBigUint64(48, 10_000_000n, true);
	view.setBigUint64(64, 1_000_000n, true);
	view.setUint32(72, 0, true);
	view.setUint32(76, 1, true);
	view.setUint8(80, 2);
	view.setBigUint64(88, 20_000_000n, true);
	view.setBigUint64(96, 64n, true);
	view.setUint32(112, 1, true);
	view.setUint32(116, 1, true);
	view.setInt32(120, 0, true);
	view.setInt32(124, 5, true);
	view.setInt32(128, 1, true);
	view.setInt32(132, 0, true);
	view.setInt32(136, 5, true);
	view.setInt32(140, 1, true);
	return bytes;
}

function compilerCapture(): Uint8Array {
	const bytes = new Uint8Array(24 + 3 * 8 * 8);
	bytes.set(Buffer.from("MALSITE1"));
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 1, true);
	view.setUint32(12, 2, true);
	view.setUint32(16, 2, true);
	view.setUint32(20, 8, true);
	const siteOne = 24 + 2 * 8 * 8;
	view.setBigUint64(siteOne, 10n, true);
	view.setBigUint64(siteOne + 2 * 8, 2n, true);
	view.setBigUint64(siteOne + 4 * 8, 128n, true);
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
	new DataView(invalid.buffer).setUint32(72, 99, true);
	expect(() => parseProfileCapture(invalid)).toThrow("outside");
});

test("legacy captures never guess between same-position operations", () => {
	const parsed = parseProfileCapture(legacyCapture());
	expect(parsed.records[0]?.frames[0]?.siteId).toBe(-1);
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-legacy-"));
	writeFileSync(path.join(directory, "capture.bin"), legacyCapture());
	expect(finalizeProfileCapture(directory, prepared, "run").findings).toEqual([]);
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
		allocationBytes: 128,
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
	) as { status: string; cpuSamples: number; allocationSamples: number };
	expect(manifest).toMatchObject({
		status: "complete",
		cpuSamples: 1,
		allocationSamples: 1,
	});
});
