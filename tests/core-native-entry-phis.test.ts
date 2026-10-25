import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	analyzeCoreNativeEntry,
	coreNativeEntryControlFlow,
} from "../src/compiler/core/core-native-entry-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";

describe("native entry phi contracts", () => {
	it.each(["boolean", "string", "f64", "boxed"] as const)(
		"keeps distinct same-target edges for a %s entry",
		(representation) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const entry = builder.createBlock([{}, {}]),
				join = builder.createBlock([{}]);
			const flag = builder.blockParameterValue(entry, 0),
				other = builder.blockParameterValue(entry, 1);
			const [seven] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [condition] = builder.appendInstruction(entry, "binary", [flag, flag], {
				attributes: { operator: "===" },
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition: condition!,
				consequent: { block: join, arguments: [seven!] },
				alternate: { block: join, arguments: [other] },
			});
			const phi = builder.blockParameterValue(join, 0);
			const [one] = builder.appendInstruction(join, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [result] = builder.appendInstruction(join, "binary", [phi, one!], {
				attributes: { operator: "+" },
			});
			const addition = builder.bodyInstructionIds(join).at(-1)!;
			builder.appendInstruction(join, "binary", [phi, one!], {
				attributes: { operator: "<" },
			});
			const comparison = builder.bodyInstructionIds(join).at(-1)!;
			builder.setTerminator(join, { kind: "return", value: result! });
			const id = builder.finish(entry).function,
				cfg = buildCoreControlFlow(program, id, { exceptions: true });
			const facts = analyzeCoreNativeEntry(
				program,
				cfg,
				[representation, "boxed"],
				undefined,
				[],
			);
			const refined = representation === "boolean" || representation === "string";
			expect(facts.valueRepresentations[phi]).toBe(refined ? "f64" : "boxed");
			expect(facts.resultRepresentation).toBe(refined ? "f64" : "boxed");
			const site = facts.instructionFacts!.find((site) => site.instruction === addition)!;
			if (refined)
				expect(site.masks).toEqual([
					COMPILER_VALUE_KIND_NUMBER,
					COMPILER_VALUE_KIND_NUMBER,
				]);
			const effects = decodeInstructionEffects(site.effectMask);
			expect(effects.mayGc).toBe(!refined);
			expect(effects.callsUserCode).toBe(!refined);
			const plan = {
				id: 0,
				function: id,
				callSites: [],
				parameterRepresentations: [representation, "boxed" as const],
				...facts,
				target: "native" as const,
				fallback: "canonical-core" as const,
				cost: { generatedCode: 1, compilerWork: 1, runtimeBenefit: 1 },
			};
			const control = coreNativeEntryControlFlow(program.function(id), plan)!;
			const roots = coreCanonicalValueRoots(program.function(id), cfg, control.edges);
			expect(roots.get(phi) ?? phi).toBe(refined ? seven : phi);
			if (refined)
				expect(
					facts.instructionFacts!.find((site) => site.instruction === comparison)!
						.inputIntegerRanges?.[0],
				).toMatchObject({
					minimum: 7,
					maximum: 7,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				});
			expect(control.edges.has(cfg.successors[entry]![0]!)).toBe(true);
			expect(control.edges.has(cfg.successors[entry]![1]!)).toBe(!refined);
			const edge = program
				.function(id)
				.kernel.terminatorEdgeStart(program.function(id).blockTerminator(entry));
			expect(control.ordinaryEdges.has(edge)).toBe(true);
			expect(control.ordinaryEdges.has(edge + 1)).toBe(!refined);
		},
	);

	it("propagates a phi kind into a later branch and phi", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[116, 101, 120, 116]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]),
			first = builder.createBlock([{}]),
			second = builder.createBlock([{}]);
		const flag = builder.blockParameterValue(entry, 0),
			other = builder.blockParameterValue(entry, 1);
		const [text] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [condition] = builder.appendInstruction(entry, "binary", [flag, flag], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: first, arguments: [text!] },
			alternate: { block: first, arguments: [other] },
		});
		const firstPhi = builder.blockParameterValue(first, 0);
		const [nan] = builder.appendInstruction(first, "binary", [firstPhi, firstPhi], {
			attributes: { operator: "!==" },
		});
		const [seven] = builder.appendInstruction(first, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setTerminator(first, {
			kind: "branch",
			condition: nan!,
			consequent: { block: second, arguments: [other] },
			alternate: { block: second, arguments: [seven!] },
		});
		const secondPhi = builder.blockParameterValue(second, 0);
		builder.setTerminator(second, { kind: "return", value: secondPhi });
		const id = builder.finish(entry).function;
		const facts = analyzeCoreNativeEntry(
			program,
			buildCoreControlFlow(program, id, { exceptions: true }),
			["boolean", "boxed"],
			undefined,
			[],
		);
		expect(facts.valueRepresentations[firstPhi]).toBe("string");
		expect(facts.valueRepresentations[secondPhi]).toBe("f64");
		expect(facts.resultRepresentation).toBe("f64");
	});

	it("removes an impossible loop backedge from a header's kind join", () => {
		const program = new CoreProgram(coreOpcodeRegistry),
			builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]),
			header = builder.createBlock([{}]),
			back = builder.createBlock(),
			exit = builder.createBlock();
		const flag = builder.blockParameterValue(entry, 0),
			other = builder.blockParameterValue(entry, 1);
		const [seven] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [seven!] },
		});
		const phi = builder.blockParameterValue(header, 0);
		const [condition] = builder.appendInstruction(header, "binary", [flag, flag], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: exit, arguments: [] },
			alternate: { block: back, arguments: [] },
		});
		builder.setTerminator(back, {
			kind: "jump",
			edge: { block: header, arguments: [other] },
		});
		builder.setTerminator(exit, { kind: "return", value: phi });
		const id = builder.finish(entry).function;
		const facts = analyzeCoreNativeEntry(
			program,
			buildCoreControlFlow(program, id, { exceptions: true }),
			["string", "boxed"],
			undefined,
			[],
		);
		expect(facts.valueRepresentations[phi]).toBe("f64");
		expect(facts.resultRepresentation).toBe("f64");
	});

	it("keeps exceptional phi inputs and handler return contracts while refining ordinary edges", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]),
			join = builder.createBlock([{}]),
			handler = builder.createBlock([{ role: "exception" }, {}]);
		const flag = builder.blockParameterValue(entry, 0),
			input = builder.blockParameterValue(entry, 1);
		builder.setHandler(entry, handler, [input]);
		builder.appendInstruction(entry, "loadGlobalProperty", [], {
			attributes: { stringIndex: 0 },
		});
		const [seven] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const [condition] = builder.appendInstruction(entry, "binary", [flag, flag], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: join, arguments: [seven!] },
			alternate: { block: join, arguments: [input] },
		});
		const phi = builder.blockParameterValue(join, 0),
			handlerPhi = builder.blockParameterValue(handler, 1);
		builder.setTerminator(join, { kind: "return", value: phi });
		builder.setTerminator(handler, { kind: "return", value: handlerPhi });
		const id = builder.finish(entry).function;
		const facts = analyzeCoreNativeEntry(
			program,
			buildCoreControlFlow(program, id, { exceptions: true }),
			["boolean", "boxed"],
			undefined,
			[],
		);
		expect(facts.valueRepresentations[phi]).toBe("f64");
		expect(facts.valueRepresentations[handlerPhi]).toBe("boxed");
		expect(facts.resultRepresentation).toBe("boxed");
	});
});
