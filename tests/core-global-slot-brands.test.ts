import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeCoreGlobalSlotBrands } from "../src/compiler/core/core-global-slot-analysis.ts";
import { installCoreGlobalSlotBrands } from "../src/compiler/core/core-global-slot-facts.ts";
import type { CoreExactHeapBrand } from "../src/compiler/core/core-heap-brands.ts";
import { analyzeCoreValueClasses } from "../src/compiler/core/core-ir-value-classes.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";

const source = `
	const FLAGS = new Uint8Array(256);
	const LIST = [1, 2];
	const SEEN = new Set();
	const EITHER = globalThis.pick ? [] : new Int32Array(2);
	let REPLACED = [];
	REPLACED = new Float64Array(1);
	function flags() { return FLAGS; }
	function list() { return LIST; }
	function seen() { return SEEN; }
	function either() { return EITHER; }
	function replaced() { return REPLACED; }
	globalThis.readers = [flags, list, seen, either, replaced];`;

function functionName(
	program: ReturnType<typeof constructSemanticProgramCore>["program"],
	nameStringIndex: number,
): string | undefined {
	const units = program.stringConstants[nameStringIndex];
	return units === undefined ? undefined : String.fromCharCode(...units);
}

// Each reader's single global load names the binding it returns.
function loadedBrands(
	evalMode: "disabled" | "runtime",
): Map<string, CoreExactHeapBrand | undefined> {
	const core = constructSemanticProgramCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/globals.js"),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: { primordials: "locked", eval: evalMode === "disabled" ? false : true },
				}),
			),
		},
		(_phase, run) => run(),
	);
	installCoreGlobalSlotBrands(
		core.program,
		analyzeCoreGlobalSlotBrands(core.program, core.context),
	);
	const brands = new Map<string, CoreExactHeapBrand | undefined>();
	for (const id of core.program.functionIds()) {
		const fn = core.program.function(id);
		const name = functionName(core.program, fn.metadata.nameStringIndex);
		if (name === undefined) continue;
		const classes = analyzeCoreValueClasses(core.program, id, core.context);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "loadGlobal"
			)
				continue;
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			brands.set(name, classes.exactHeapBrand(value));
		}
	}
	return brands;
}

describe("global slot brands", () => {
	it("give reads of a const its Array or TypedArray class", () => {
		const brands = loadedBrands("disabled");
		expect(brands.get("flags")).toBe("Uint8Array");
		expect(brands.get("list")).toBe("Array");
	});

	it("leave collections, unknown classes and reassigned bindings unbranded", () => {
		const brands = loadedBrands("disabled");
		expect(brands.has("seen")).toBe(true);
		expect(brands.get("seen")).toBeUndefined();
		expect(brands.get("either")).toBeUndefined();
		expect(brands.get("replaced")).toBeUndefined();
	});

	it("are absent when direct eval can write globals", () => {
		const brands = loadedBrands("runtime");
		expect(brands.get("flags")).toBeUndefined();
		expect(brands.get("list")).toBeUndefined();
	});
});
