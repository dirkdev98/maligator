import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hostGapFractions } from "../scripts/bench-compiler-host-gap.ts";
import type { CompilerHostGapKernelResult } from "../scripts/bench-compiler-host-gap.ts";

const fixture = "bench/compiler-host-gap.mjs";

function fixtureOutput(id: string): {
	readonly id: string;
	readonly operations: number;
	readonly checksum: number;
} {
	const parsed: unknown = JSON.parse(
		execFileSync(process.execPath, [fixture, id], { encoding: "utf8" }),
	);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("compiler host-gap fixture produced an invalid report");
	}
	return parsed as {
		readonly id: string;
		readonly operations: number;
		readonly checksum: number;
	};
}

describe("compiler host-gap ladder", () => {
	it("covers every required primitive and algorithm kernel", () => {
		const kernels = JSON.parse(
			execFileSync(process.execPath, [fixture, "--list"], { encoding: "utf8" }),
		) as ReadonlyArray<{ readonly id: string; readonly group: string }>;
		expect(kernels.filter(({ group }) => group === "primitive")).toHaveLength(19);
		expect(kernels.filter(({ group }) => group === "algorithm")).toHaveLength(15);
		expect(new Set(kernels.map(({ id }) => id)).size).toBe(kernels.length);
	});

	it.each(["map-operations", "memory-versions"])(
		"keeps %s work and checksums deterministic",
		(id) => {
			const first = fixtureOutput(id);
			const second = fixtureOutput(id);
			expect(second.id).toBe(first.id);
			expect(second.operations).toBe(first.operations);
			expect(second.checksum).toBe(first.checksum);
			expect(first.operations).toBeGreaterThan(0);
		},
	);

	it("classifies only positive kernel host gaps", () => {
		const makeResult = (
			category: CompilerHostGapKernelResult["category"],
			hostGapMs: number,
		): CompilerHostGapKernelResult =>
			({ category, hostGapMs }) as CompilerHostGapKernelResult;
		const fractions = hostGapFractions([
			makeResult("allocation-gc", 30),
			makeResult("function-closure-dispatch", 10),
			makeResult("compiler-algorithms", -20),
		]);
		expect(fractions["allocation-gc"]).toBe(0.75);
		expect(fractions["function-closure-dispatch"]).toBe(0.25);
		expect(fractions["compiler-algorithms"]).toBe(0);
	});
});
