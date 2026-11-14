import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const factories = [
	["from", "Array.from({length:4},(_,bias)=>function mapped(value){return value+bias;})"],
	["map", "[1,2,3,4].map(bias=>function mapped(value){return value+bias;})"],
] as const;

describe("mapped element call admission", () => {
	it.each(factories)(
		"guards %s result callees while keeping captures boxed",
		(_name, factory) => {
			const result = inspectStaticValueFunction(
				`function target(){const callbacks=${factory};let total=0;for(let i=0;i<16;i++)total+=callbacks[i&3](i);return total;}globalThis.target=target;`,
				"target",
				{ locked: false, realms: true },
			);
			const mapped = result.image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(result.image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "mapped",
			)!;
			expect(mapped).toBeDefined();
			expect(
				result.native.instructions.some(
					(plan) =>
						plan?.kind === "call" &&
						plan.guardedFunctionIndices?.includes(mapped.functionIndex),
				),
			).toBe(true);
			expect(
				result.fn.instructions.some((instruction) => instruction.opcode === "CALL"),
			).toBe(true);
			for (const instruction of mapped.body.instructions)
				if (instruction.opcode === "LOAD_CAPTURED")
					expect(mapped.registerRepresentations[instruction.dst]).toBe("boxed");
		},
	);

	it.each([
		["an unknown mapper", "Array.from({length:4},globalThis.mapper)"],
		["a mapper returning data", "Array.from({length:4},(_,bias)=>bias)"],
		[
			"an unrelated factory",
			"globalThis.build({length:4},(_,bias)=>function mapped(value){return value+bias;})",
		],
	])("retains generic element calls for %s", (_name, factory) => {
		const result = inspectStaticValueFunction(
			`function target(){const callbacks=${factory};let total=0;for(let i=0;i<16;i++)total+=callbacks[i&3](i);return total;}globalThis.target=target;`,
			"target",
			{ locked: false, realms: true },
		);
		expect(
			result.native.instructions.some(
				(plan) => plan?.kind === "call" && (plan.guardedFunctionIndices?.length ?? 0) > 0,
			),
		).toBe(false);
	});
});

describe("mutable Array iteration admission", () => {
	it.each(["forEach", "map", "filter", "some", "every", "find", "findIndex", "reduce"])(
		"keeps one loaded-method guard and the generic %s invocation",
		(method) => {
			const expression =
				method === "reduce"
					? "values.reduce((sum,value)=>sum+value,0)"
					: `values.${method}(value=>value>2)`;
			const { core } = inspectStaticValueFunction(
				`function target(values){return ${expression};}globalThis.target=target;`,
				"target",
				{ locked: false, realms: true },
			);
			expect(
				core.filter(
					(op) =>
						op.opcode === "loadIntrinsic" &&
						op.attributes.intrinsic === "__arrayIterationEligible",
				),
			).toHaveLength(1);
			expect(
				core.some(
					(op) => op.opcode === "call" && op.attributes.guardedInlineFallback === true,
				),
			).toBe(true);
		},
	);
});
