import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";

const sequence =
	"function* sequence(seed) { for (let index = 0; index < 12; index++) yield seed + index * 2; }";
const traversal = "for (const value of sequence(round)) checksum += value;";

function fusionCount(
	generator = sequence,
	body = traversal,
	extra = "",
	engine: { realms?: boolean; primordials?: "locked" | "mutable"; eval?: boolean } = {},
): number {
	const source = `${generator}
		function hot(count) {
			let checksum = 0;
			for (let round = 0; round < count; round++) { ${body} }
			return checksum;
		}
		${extra}
		console.log(hot(32));`;
	let report: CoreOptimizationReport | undefined;
	const directory = mkdtempSync(join(tmpdir(), "mal-generator-fusion-"));
	try {
		const sourcePath = join(directory, "main.mjs");
		writeFileSync(sourcePath, source);
		compileEntrypoint(sourcePath, {
			buildConfig: resolveBuildConfig({ engine }),
			coreInstrumentation: "full",
			afterCoreOptimization(_program, _context, optimizationReport) {
				report = optimizationReport;
			},
		});
		return report!.transforms.appliedByKind["generator-fusion"]!;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("private generator fusion", () => {
	it("fuses a numeric generator consumed only by for-of", () => {
		expect(fusionCount()).toBeGreaterThan(0);
	});
	it("fuses independent traversals with continue and break", () => {
		expect(
			fusionCount(
				sequence,
				`${traversal} for (const value of sequence(round)) { if (value & 1) continue; checksum += value; if (value > 9) break; }`,
			),
		).toBe(2);
	});
	it.each([
		{
			behavior: "observed callable prototype",
			extra: "console.log(sequence.prototype);",
		},
		{
			behavior: "mutated iterator prototype",
			extra: "sequence.prototype.next = () => ({ done: true });",
		},
		{ behavior: "escaping invocation", extra: "console.log(sequence(3));" },
		{
			behavior: "generator returned by a public callable",
			extra: "globalThis.makeSequence = () => sequence(3);",
		},
	])("keeps the protocol for $behavior", ({ extra }) => {
		expect(fusionCount(sequence, traversal, extra)).toBe(0);
	});
	it("keeps the protocol across realms", () => {
		expect(fusionCount(sequence, traversal, "", { realms: true })).toBe(0);
	});
	it.each([
		{ behavior: "mutable primordials", engine: { primordials: "mutable" as const } },
		{ behavior: "dynamic evaluation", engine: { eval: true } },
	])("keeps the protocol with $behavior", ({ engine }) => {
		expect(fusionCount(sequence, traversal, "", engine)).toBe(0);
	});
	it("keeps generator cleanup on early exit", () => {
		expect(
			fusionCount(
				"function* sequence(seed) { try { for (let index = 0; index < 12; index++) yield seed + index; } finally { console.log(seed); } }",
				"for (const value of sequence(round)) { checksum += value; break; }",
			),
		).toBe(0);
	});
	it("keeps coercion in a generator body", () => {
		expect(
			fusionCount(
				sequence,
				"for (const value of sequence({ valueOf() { return round; } })) checksum += value;",
			),
		).toBe(0);
	});
	it("retains state whose initialization can be skipped by completion", () => {
		expect(
			fusionCount(
				"function* sequence(seed) { if (seed < 0) return; const step = seed + 2; for (let index = 0; index < 12; index++) yield step + index; }",
			),
		).toBe(0);
	});
});
