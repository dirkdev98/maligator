import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { coreFunctions, coreOperations } from "./helpers/core-inspection.ts";

function optimizedProgram(fixture: string): CoreProgram {
	let optimized: CoreProgram | undefined;
	compileEntrypoint(fixture, {
		buildConfig: resolveBuildConfig({}),
		afterCoreOptimization(program) {
			optimized = program;
		},
	});
	return optimized!;
}

describe("captures of scopes that run once", () => {
	const program = optimizedProgram("tests/local/single-activation-captures.cjs");
	const searches = coreFunctions(program).filter(
		(fn) =>
			String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			) === "search",
	);
	// `search(values, key, select, compare)` still dispatches when it calls `compare` itself.
	const callsComparator = searches.map((fn) =>
		coreOperations(fn).some(
			({ opcode, inputs }) =>
				opcode === "call" && inputs[0] === fn.kernel.functionParameter(3),
		),
	);

	it("inline a parameter's closure whose captured wrapper scope runs once", () => {
		expect(callsComparator).toContain(false);
	});

	it("keep calling closures whose factory runs more than once", () => {
		expect(callsComparator).toContain(true);
	});
});
