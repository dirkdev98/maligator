import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";

const fixture = path.resolve("tests/local/private-field-loops.mjs");

function cachedReadsByFunction(): ReadonlyMap<string, { cached: number; plain: number }> {
	const image = compileEntrypoint(fixture, {
		buildConfig: resolveBuildConfig({
			engine: { primordials: "locked", eval: false, realms: false },
		}),
	});
	const reads = new Map<string, { cached: number; plain: number }>();
	for (const fn of image.native.functions) {
		const name = String.fromCharCode(
			...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
		);
		const counts = reads.get(name) ?? { cached: 0, plain: 0 };
		for (const instruction of fn.body.instructions) {
			if (instruction.opcode !== "LOAD_PRIVATE") continue;
			if (instruction.cached === undefined) counts.plain++;
			else counts.cached++;
		}
		reads.set(name, counts);
	}
	return reads;
}

describe("stable private field reads in loops", () => {
	const reads = cachedReadsByFunction();

	it("carry construction-only fields of invariant receivers across iterations", () => {
		for (const name of ["readTags", "readCells", "sum"])
			expect(reads.get(name)?.cached, name).toBeGreaterThan(0);
	});

	it("keep reading fields that the loop or a resumed activation can change", () => {
		for (const name of ["readMarks", "Counter", "#reader", "#watch"]) {
			expect(reads.get(name)?.cached, name).toBe(0);
			expect(reads.get(name)?.plain, name).toBeGreaterThan(0);
		}
	});
});
