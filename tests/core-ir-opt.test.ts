import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler-facts.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { deserializeVmDefinition, serializeVmDefinition } from "../src/serialize-vm.ts";

function programWithConstants(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [first] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [duplicate] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [unused] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 2 },
	});
	const [moved] = builder.appendInstruction(entry, "move", [duplicate!]);
	void first;
	void unused;
	builder.setTerminator(entry, { kind: "return", value: moved! });
	const core = builder.finish(entry);
	return coreProgram([core]);
}

function coreProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

describe("Core IR optimizer", () => {
	it("eliminates copies, locally numbers values, and removes dead producers", () => {
		const result = executeCoreOptimizations(programWithConstants());
		const fn = result.program.functions[0]!;
		expect(result.changed).toBe(true);
		expect(fn.blocks[0]!.instructions).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			attributes: { value: 1 },
		});
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.blocks[0]!.instructions[0]!.outputs[0],
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		expect(result.passes.some(({ changed }) => changed)).toBe(true);
	});

	it("folds exact string property keys on the development Core path", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function read(object) { object.answer = 1; return object.answer; }",
			"core-static-property.js",
		);
		let opcodes: Array<string> = [];
		compileSemanticProgramToVmDefinition(semantic, {
			optimization: "development",
			afterCoreOptimization(program) {
				opcodes = program.functions.flatMap((fn) =>
					fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
				);
			},
		});

		expect(opcodes).toContain("storePropertyStatic");
		expect(opcodes).toContain("loadPropertyStatic");
	});

	it("attaches guarded builtin identity and semantics to Core calls", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function append(array, value) { array.push(value); }",
			"core-known-builtin.js",
		);
		let call: CoreFunction["blocks"][number]["instructions"][number] | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				call = program.functions
					.flatMap(({ blocks }) => blocks)
					.flatMap(({ instructions }) => instructions)
					.find(({ opcode }) => opcode === "call");
			},
		});

		expect(call?.attributes.knownBuiltinCall).toMatchObject({
			operation: "Array.prototype.push",
			identity: {
				kind: "known",
				proof: {
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: [{ kind: "fallback" }],
				},
			},
			semantics: {
				kind: "known",
				value: { result: "array-length" },
			},
		});
	});

	it("erases exact primitive builtin dispatch only with a locked-world proof", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			'function first() { return "alpha,beta".split(",")[0]; }',
			"core-exact-builtin.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const instructions = optimized!.functions[1]!.blocks.flatMap(
			({ instructions: blockInstructions }) => blockInstructions,
		);
		const builtin = instructions.find(({ opcode }) => opcode === "callBuiltin");
		expect(builtin).toBeDefined();
		expect(builtin?.attributes.operation).toBe("String.prototype.split");
		expect(
			instructions.some((instruction) => {
				const index = instruction.attributes.stringIndex;
				return (
					instruction.opcode === "loadPropertyStatic" &&
					typeof index === "number" &&
					String.fromCharCode(...optimized!.stringConstants[index]!) === "split"
				);
			}),
		).toBe(false);
	});

	it("inlines an exact linear closure while retaining its source chain", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(value) {
				function addOne(input) { return input + 1; }
				return addOne(value);
			}`,
			"core-inline.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[1]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(false);
		const binary = outer.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "binary")!;
		expect(optimized!.sourcePositions[binary.sourcePosition!]).toMatchObject({
			inlinedFunctionIndex: 2,
		});
		expect(optimized!.compilation?.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.applied.inline",
				outcome: "applied",
			}),
		);
	});

	it("does not inline an activation whose bindings escape into an inner closure", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(input) {
				function valuesOf(value) {
					return Object.keys(value).map((key) => value[key]);
				}
				return valuesOf(input);
			}`,
			"core-inline-captured-activation.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[1]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(true);
		expect(optimized!.compilation?.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.declined.inner-closure",
				outcome: "declined",
				reason: "inner-closure",
			}),
		);
	});

	it("selects a fixed-shape Core stack object with explicit materialization", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, escape) {
				const object = { value };
				if (escape) return object;
				return object.value;
			}`,
			"core-stack-object.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(optimized!.functions[1]!.regions).toContainEqual(
			expect.objectContaining({ kind: "stack-object-plan" }),
		);
		expect(definition.functions[1]!.regions).toContainEqual(
			expect.objectContaining({
				kind: "stack-object-plan",
				sites: [expect.objectContaining({ materializations: [expect.any(Object)] })],
			}),
		);
		expect(definition.profileRemarks).toContainEqual(
			expect.objectContaining({
				code: "optimization.applied.partial-escape-materialization",
			}),
		);
	});

	it("rejects a stack object that enters a mixed-value join", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, useObject) {
				let result = value;
				if (useObject) result = { kind: "chosen", value };
				return result;
			}`,
			"core-stack-object-mixed-join.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(
			optimized!.functions[1]!.regions.some(({ kind }) => kind === "stack-object-plan"),
		).toBe(false);
	});

	it("guards one inherited read before using activation-local object slots", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value) {
				const object = { value };
				const inherited = object.toString;
				return object.value + (typeof inherited === "function" ? 1 : 0);
			}`,
			"core-stack-object-inherited.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const coreRegion = optimized!.functions[1]!.regions.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(coreRegion?.data).toMatchObject({
			license: {
				guard: {
					dependencies: [expect.objectContaining({ kind: "epoch" })],
				},
				materialization: "on-demand",
			},
		});
		expect(JSON.stringify(coreRegion?.data)).toMatch(
			/"inheritedAccess":\{"\$coreInstruction":\d+\}/,
		);
		const vmRegion = definition.functions[1]!.regions?.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(vmRegion?.license.materialization).toBe("on-demand");
		if (vmRegion?.kind !== "stack-object-plan") throw new Error("expected stack region");
		expect(typeof vmRegion.sites[0]!.inheritedAccessIp).toBe("number");
	});

	it("certifies a fully local stack object without a materializer", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value) {
				const object = { value };
				return object.value;
			}`,
			"core-local-stack-object.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const coreRegion = optimized!.functions[1]!.regions.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(coreRegion?.data).toMatchObject({
			license: {
				guard: { obligations: [{ kind: "fallback" }] },
				materialization: "none",
			},
			sites: [{ materializations: [] }],
		});

		const restored = deserializeVmDefinition(serializeVmDefinition(definition));
		const vmRegion = restored.functions[1]!.regions?.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(vmRegion?.kind).toBe("stack-object-plan");
		if (vmRegion?.kind !== "stack-object-plan") throw new Error("expected stack region");
		expect(vmRegion.license.materialization).toBe("none");
		expect(vmRegion.sites).toHaveLength(1);
		expect(vmRegion.sites[0]!.materializations).toEqual([]);
	});

	it("preserves every selected region beyond the former fixed VM ceiling", () => {
		const declarations = Array.from(
			{ length: 41 },
			(_, index) =>
				`const object${index} = { value: values[${index}] };
				total += object${index}.value;`,
		).join("\n");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function many(values) {
				let total = 0;
				${declarations}
				return total;
			}`,
			"core-many-regions.js",
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const regions = definition.functions[1]!.regions!;

		expect(regions.length).toBeGreaterThan(40);
		expect(regions.filter(({ kind }) => kind === "stack-object-plan")).toHaveLength(41);
		expect(
			deserializeVmDefinition(serializeVmDefinition(definition)).functions[1]!.regions,
		).toEqual(regions);
	});

	it("certifies only closed String.split projections", () => {
		const compile = (body: string): CoreProgram => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`function project(value) { ${body} }`,
				"core-string-split.js",
			);
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToVmDefinition(semantic, {
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			return optimized!;
		};

		const closed = compile(
			'const fields = value.split(";"); return fields[1] + fields.length;',
		);
		const regions = closed.functions[1]!.regions.filter(
			({ kind }) => kind === "string-split-projection",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			kind: "string-split-projection",
			data: {
				license: {
					genericTwin: "retained",
					materialization: "whole-region",
				},
				representation: "projected-elements",
			},
		});
		const obligations = (
			regions[0]!.data.license as {
				readonly guard: { readonly obligations: ReadonlyArray<unknown> };
			}
		).guard.obligations;
		expect(obligations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "fallback" }),
				expect.objectContaining({ kind: "materialize" }),
			]),
		);

		const escaping = compile('return value.split(";");');
		expect(
			escaping.functions[1]!.regions.some(
				({ kind }) => kind === "string-split-projection",
			),
		).toBe(false);
	});

	it("folds exact object observations before selecting partial escape regions", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, escape) {
				const object = { value };
				const alias = object;
				if (escape) return alias;
				return typeof object === "object" && object === alias
					? object.value
					: -1;
			}`,
			"core-stack-object-observations.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const fn = optimized!.functions[1]!;
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.some(
					(instruction) =>
						instruction.opcode === "unary" &&
						instruction.attributes.operator === "typeof",
				),
		).toBe(false);
		const region = fn.regions.find(({ kind }) => kind === "stack-object-plan");
		expect(region).toBeDefined();
		expect(region!.data).toMatchObject({
			sites: [expect.objectContaining({ materializations: [expect.any(Object)] })],
		});
	});

	it("removes TDZ checks only when Core SSA excludes the Empty sentinel", () => {
		const optimizedOpcodes = (source: string): Array<string> => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(source, "core-tdz.js");
			let opcodes: Array<string> = [];
			compileSemanticProgramToVmDefinition(semantic, {
				afterCoreOptimization(program) {
					opcodes = program.functions.flatMap((fn) =>
						fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
					);
				},
			});
			return opcodes;
		};
		const safe = optimizedOpcodes(`
			function safe(object) {
				let errors = 0;
				try { object.x; } catch { errors = errors + 1; }
				return errors + 1;
			}
		`);
		const unsafe = optimizedOpcodes(`
			function unsafe() { return value; let value = 1; }
		`);

		expect(safe).not.toContain("throwIfTdz");
		expect(unsafe).toContain("throwIfTdz");
	});

	it("folds primitive arithmetic with exact f64 edge semantics", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [one] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [nan] = builder.appendInstruction(entry, "binary", [zero!, zero!], {
			attributes: { operator: "/" },
		});
		const [infinity] = builder.appendInstruction(entry, "binary", [one!, zero!], {
			attributes: { operator: "/" },
		});
		const [equal] = builder.appendInstruction(entry, "binary", [nan!, infinity!], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(entry, { kind: "return", value: equal! });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks[0]!.instructions).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createBoolean",
			attributes: { value: false },
		});
		expect(fn.values.find(({ id }) => id === equal)?.representation).toBe("boolean");
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("folds primitive control and removes unreachable blocks", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const dead = builder.createBlock();
		const body = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: dead, arguments: [] },
		});
		const [deadValue] = builder.appendInstruction(dead, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.setTerminator(dead, { kind: "return", value: deadValue! });
		const [result] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(body, { kind: "return", value: result! });
		const original = builder.finish(entry);
		const program = coreProgram([{ ...original, bodyEntry: body }]);

		const fn = executeCoreOptimizations(program).program.functions[0]!;
		expect(fn.blocks).toHaveLength(2);
		expect(fn.bodyEntry).toBe(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "jump",
			edge: { block: 1 },
		});
		expect(fn.blocks[0]!.instructions).toHaveLength(0);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("folds a primitive switch with JavaScript strict equality", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const one = builder.createBlock();
		const two = builder.createBlock();
		const fallback = builder.createBlock();
		const [discriminant] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(entry, {
			kind: "switch",
			discriminant: discriminant!,
			cases: [
				{ value: { kind: "number", value: 1 }, edge: { block: one, arguments: [] } },
				{ value: { kind: "number", value: 2 }, edge: { block: two, arguments: [] } },
			],
			default: { block: fallback, arguments: [] },
		});
		for (const [block, value] of [
			[one, 1],
			[two, 2],
			[fallback, 3],
		] as const) {
			const [result] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value },
			});
			builder.setTerminator(block, { kind: "return", value: result! });
		}

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({ kind: "return" });
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			attributes: { value: 2 },
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("combines linear SSA blocks by substituting edge arguments", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.block(entry).parameters[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [parameter] },
		});
		const bodyParameter = builder.block(body).parameters[0]!.value;
		const [result] = builder.appendInstruction(body, "call", [
			bodyParameter,
			bodyParameter,
		]);
		builder.setTerminator(body, { kind: "return", value: result! });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "call",
			inputs: [parameter, parameter],
		});
		expect(fn.values).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: bodyParameter })]),
		);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("optimizes outside a region while preserving its claimed instruction slice", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const call = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.opcode === "call",
		)!;
		const protectedFunction = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [call.id],
					claimedInstructions: [call.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { call: { $coreInstruction: call.id } },
				},
			],
		};

		const optimized = executeCoreOptimizations(coreProgram([protectedFunction])).program
			.functions[0]!;
		const optimizedCall = optimized.blocks[0]!.instructions.find(
			(instruction) => instruction.id === call.id,
		);

		expect(optimizedCall).toEqual(call);
		expect(
			optimized.blocks[0]!.instructions.filter(
				(instruction) => instruction.opcode === "createNumber",
			),
		).toHaveLength(0);
		expect(() => verifyCoreFunction(optimized, coreOpcodeRegistry)).not.toThrow();
	});

	it("rejects a pass result that mutates a claimed instruction", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [dead] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const claimed = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === dead,
		)!;
		const protectedFunction = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [claimed.id],
					claimedInstructions: [claimed.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { producer: { $coreInstruction: claimed.id } },
				},
			],
		};

		const optimized = executeCoreOptimizations(coreProgram([protectedFunction])).program
			.functions[0]!;

		expect(
			optimized.blocks[0]!.instructions.find(
				(instruction) => instruction.id === claimed.id,
			),
		).toEqual(claimed);
		expect(() => verifyCoreFunction(optimized, coreOpcodeRegistry)).not.toThrow();
	});
});
