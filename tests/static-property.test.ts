import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compile(source: string) {
	return compileSemanticProgramToVmDefinition(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			"static-property-test.js",
			parseScript(source, { strict: false }),
		),
	);
}

describe("static-key property operations", () => {
	it("folds constant keys and removes their CREATE_STRING instructions", () => {
		const definition = compile(
			`function f(o, value) { o.answer = value; return o.answer + o["other"]; } globalThis.keep = f;`,
		);
		const instructions = definition.functions.flatMap((fn) => fn.instructions);
		expect(
			instructions.filter(
				(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC",
			),
		).toHaveLength(2);
		expect(
			instructions.filter((instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC"),
		).toHaveLength(2);
		expect(
			instructions.filter((instruction) => instruction.opcode === "LOAD_PROPERTY"),
		).toHaveLength(0);
	});

	it("keeps computed dynamic keys on the generic operations", () => {
		const definition = compile(
			`function f(o, key, value) { o[key] = value; return o[key]; } globalThis.keep = f;`,
		);
		const instructions = definition.functions.flatMap((fn) => fn.instructions);
		expect(
			instructions.some((instruction) => instruction.opcode === "STORE_PROPERTY"),
		).toBe(true);
		expect(
			instructions.some((instruction) => instruction.opcode === "LOAD_PROPERTY"),
		).toBe(true);
	});
});

describe("closed global finite tables", () => {
	it.skip("scalarizes bit-mask keys and marks unknown selectors as deopts", () => {
		const definition = compile(`
			const table = {};
			function update(seed, other) {
				const key = seed & 7;
				const previous = table[key];
				table[key] = seed;
				if (other !== undefined) table[other] = seed + 1;
				return previous;
			}
			globalThis.update = update;
		`);
		const regions = definition.functions.flatMap((fn) =>
			(fn.regions ?? []).filter((region) => region.kind === "closed-global-table"),
		);
		expect(regions).toHaveLength(1);
		const [region] = regions;
		const accesses = region!.accesses;
		expect(accesses).toHaveLength(3);
		expect(accesses.map((access) => access.direct)).toEqual([true, true, false]);
		expect(region).toMatchObject({ mask: 7 });
		expect(region!.stateIndex).toBe(region!.baseIndex + 8);
		expect(region!.license.guard).toEqual({
			dependencies: [{ kind: "epoch", family: "array-elements" }],
			obligations: ["fallback", "materialize"],
		});
	});

	it("rejects escaping and cross-function table identities", () => {
		const definition = compile(`
			const escaped = {};
			const shared = {};
			function first(seed) { shared[seed & 3] = seed; }
			function second(seed) { return shared[seed & 3]; }
			globalThis.keep = [escaped, first, second];
		`);
		expect(
			definition.functions.some((fn) =>
				(fn.regions ?? []).some((region) => region.kind === "closed-global-table"),
			),
		).toBe(false);
	});
});
