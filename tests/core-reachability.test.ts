import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import {
	analyzeCoreFunctionReachability as analyzeCoreFunctionReachabilityWithContext,
	compactCoreProgramFunctions as compactCoreProgramFunctionsWithContext,
} from "../src/compiler/core/core-ir-reachability.ts";
import { CORE_KNOWN_OWN_SLOT_ATTRIBUTE } from "../src/compiler/core/core-ir-shape-provenance.ts";
import {
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
} from "../src/compiler/core/core-ir-value-kinds.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import type { CompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";

function moduleFacts(path: string, sourceClosed: boolean): CompilerProgramFacts {
	const configured = compilerProgramFactsFromConfig(
		resolveBuildConfig({ engine: { eval: sourceClosed ? false : true } }),
	);
	return sourceClosed
		? withProgramClosure(
				configured,
				programClosureCertificate(
					{ kind: "whole-program", entry: path },
					[{ kind: "entry-module", module: path }],
					[],
				),
			)
		: configured;
}

const contexts = new WeakMap<CoreProgram, CoreCompilationContext>();

function contextFor(program: CoreProgram): CoreCompilationContext {
	const context = contexts.get(program);
	if (context === undefined) throw new Error("missing reachability test context");
	return context;
}

function analyzeCoreFunctionReachability(program: CoreProgram) {
	return analyzeCoreFunctionReachabilityWithContext(
		program,
		undefined,
		contextFor(program),
	);
}

function compactCoreProgramFunctions(
	program: CoreProgram,
	reachability = analyzeCoreFunctionReachability(program),
) {
	const result = compactCoreProgramFunctionsWithContext(
		program,
		reachability,
		contextFor(program),
	);
	if (result.context !== undefined) contexts.set(result.program, result.context);
	return result;
}

function coreModule(source: string, sourceClosed: boolean): CoreProgram {
	const path = sourceClosed ? "closed-reachability.mjs" : "open-reachability.mjs";
	const compilation = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, path, parseModule(source)),
		{ facts: moduleFacts(path, sourceClosed) },
	);
	contexts.set(compilation.program, compilation.context);
	return compilation.program;
}

const DEAD_CYCLE = `
	function deadA() { return deadB(); }
	function deadB() { return deadA(); }
	function live() { return 41; }
	globalThis.answer = live() + 1;
`;

function leafFunction(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: value! });
	return builder.finish(entry);
}

function closedProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	const shell = coreModule("", true);
	const program = { ...shell, functions };
	contexts.set(program, contextFor(shell));
	return program;
}

function finitePlusOpaqueProgram(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
		parameterCount: 2,
	});
	const entry = builder.createBlock([{}, {}]);
	const [opaque, condition] = builder.block(entry).parameters.map(({ value }) => value);
	const left = builder.createBlock();
	const right = builder.createBlock();
	const join = builder.createBlock([{}]);
	const [finite] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: 1 },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: left, arguments: [] },
		alternate: { block: right, arguments: [] },
	});
	builder.setTerminator(left, {
		kind: "jump",
		edge: { block: join, arguments: [finite!] },
	});
	builder.setTerminator(right, {
		kind: "jump",
		edge: { block: join, arguments: [opaque!] },
	});
	const callee = builder.block(join).parameters[0]!.value;
	const [receiver] = builder.appendInstruction(join, "createUndefined", []);
	const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
	builder.setTerminator(join, { kind: "return", value: result! });
	return closedProgram([builder.finish(entry), leafFunction(1), leafFunction(2)]);
}

function anyScriptProgram(): CoreProgram {
	const functionCount = 7;
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const discriminant = builder.block(entry).parameters[0]!.value;
	const join = builder.createBlock([{}]);
	const candidates = Array.from(
		{ length: 5 },
		(_unused, index) =>
			builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: index + 1 },
			})[0]!,
	);
	builder.setTerminator(entry, {
		kind: "switch",
		discriminant,
		cases: candidates.slice(0, -1).map((candidate, index) => ({
			value: { kind: "number" as const, value: index },
			edge: { block: join, arguments: [candidate] },
		})),
		default: { block: join, arguments: [candidates.at(-1)!] },
	});
	const callee = builder.block(join).parameters[0]!.value;
	const [receiver] = builder.appendInstruction(join, "createUndefined", []);
	const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
	builder.setTerminator(join, { kind: "return", value: result! });
	return closedProgram([
		builder.finish(entry),
		...Array.from({ length: functionCount - 1 }, (_unused, index) =>
			leafFunction(index + 1),
		),
	]);
}

function installedFunctionProgram(kind: "host" | "namespace"): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [created] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: 1 },
	});
	builder.appendInstruction(entry, "storeGlobal", [created!], {
		attributes: { index: 0 },
	});
	const [result] =
		kind === "namespace"
			? builder.appendInstruction(entry, "createModuleNamespace", [], {
					attributes: { exports: [{ nameStringIndex: 0, slot: 0 }] },
				})
			: builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: result! });
	const shell = closedProgram([builder.finish(entry), leafFunction(1), leafFunction(2)]);
	const program = {
		...shell,
		stringConstants: [[120]],
		globalCount: 1,
	};
	const context = contextFor(shell);
	contexts.set(program, {
		...context,
		data: {
			...context.data,
			hostInstallCandidates:
				kind === "host"
					? [{ installer: "test", exports: [{ name: "installed", slot: 0 }] }]
					: [],
		},
	});
	return program;
}

describe("Core whole-program function reachability", () => {
	it("removes an unreachable recursive cycle from a source-closed module", () => {
		const program = coreModule(DEAD_CYCLE, true);
		const analysis = analyzeCoreFunctionReachability(program);
		const result = compactCoreProgramFunctions(program, analysis);

		expect(program.functions).toHaveLength(4);
		expect([...analysis.executable].sort((left, right) => left - right)).toEqual([0, 3]);
		expect([...analysis.retained].sort((left, right) => left - right)).toEqual([0, 3]);
		expect(result.changed).toBe(true);
		expect(result.program.functions).toHaveLength(2);
		expect(result.program.functions.map(({ functionIndex }) => functionIndex)).toEqual([
			0, 1,
		]);
		expect(result.oldToNew).toEqual(
			new Map([
				[0, 0],
				[3, 1],
			]),
		);
	});

	it("does not activate publication edges in an unreachable body", () => {
		const program = coreModule(
			`
				function hidden() { return 7; }
				function deadPublisher() { globalThis.hidden = hidden; }
				globalThis.answer = 1;
			`,
			true,
		);
		const analysis = analyzeCoreFunctionReachability(program);

		expect([...analysis.executable]).toEqual([0]);
		expect([...analysis.retained]).toEqual([0]);
		expect(compactCoreProgramFunctions(program, analysis).program.functions).toHaveLength(
			1,
		);
	});

	it("activates publication from an executable body", () => {
		const program = coreModule(
			`
				function published() { return 7; }
				globalThis.published = published;
			`,
			true,
		);
		const analysis = analyzeCoreFunctionReachability(program);
		const compacted = compactCoreProgramFunctions(program, analysis);

		expect([...analysis.executable].sort((left, right) => left - right)).toEqual([0, 1]);
		expect(compacted.program.functions).toHaveLength(2);
	});

	it("densely relocates live Core metadata when every function remains executable", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			metadata: { nameStringIndex: 1, sourcePath: "metadata-compaction.js" },
		});
		const entry = builder.createBlock();
		const [stringValue] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 3 },
			sourcePosition: 3,
		});
		const [bigintValue] = builder.appendInstruction(entry, "createBigint", [], {
			attributes: { bigintIndex: 1 },
		});
		const [template] = builder.appendInstruction(
			entry,
			"instantiateLiteralTemplate",
			[],
			{ attributes: { templateOffset: 2 } },
		);
		const [object] = builder.appendInstruction(
			entry,
			"createObjectShaped",
			[stringValue!, template!],
			{
				attributes: { keyStringIndices: [4, 1] },
			},
		);
		const stringBlock = builder.createBlock();
		const bigintBlock = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "switch",
			discriminant: stringValue!,
			cases: [
				{
					value: { kind: "string", index: 4 },
					edge: { block: stringBlock, arguments: [] },
				},
			],
			default: { block: bigintBlock, arguments: [] },
			sourcePosition: 3,
		});
		builder.setTerminator(stringBlock, { kind: "return", value: object! });
		builder.setTerminator(bigintBlock, { kind: "return", value: bigintValue! });
		const shell = closedProgram([builder.finish(entry)]);
		const program: CoreProgram = {
			...shell,
			stringConstants: [[100], [110], [101], [118], [107]],
			bigintConstants: [11n, 22n],
			literalTemplateData: [5, 2, 8, 2, 5, 3, 6, 1],
			sourcePositions: [
				{ line: 1, column: 0 },
				{ line: 20, column: 2 },
				{ line: 2, column: 0 },
				{
					line: 30,
					column: 3,
					inlinedFunctionIndex: 0,
					callerPosId: 1,
				},
			],
		};
		contexts.set(program, contextFor(shell));

		const compacted = compactCoreProgramFunctions(program);
		const fn = compacted.program.functions[0]!;
		const instructions = fn.blocks.flatMap(({ instructions }) => instructions);
		const createString = instructions.find(({ opcode }) => opcode === "createString")!;
		const createBigint = instructions.find(({ opcode }) => opcode === "createBigint")!;
		const createObject = instructions.find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		const instantiate = instructions.find(
			({ opcode }) => opcode === "instantiateLiteralTemplate",
		)!;
		const switched = fn.blocks.find(
			({ terminator }) => terminator.kind === "switch",
		)!.terminator;

		expect(compacted.changed).toBe(true);
		expect(compacted.program.functions).toHaveLength(1);
		expect(compacted.program.stringConstants).toEqual([[110], [118], [107]]);
		expect(compacted.program.bigintConstants).toEqual([22n]);
		expect(compacted.program.literalTemplateData).toEqual([8, 2, 5, 1, 6, 0]);
		expect(compacted.program.sourcePositions).toEqual([
			{ line: 20, column: 2 },
			{
				line: 30,
				column: 3,
				inlinedFunctionIndex: 0,
				callerPosId: 0,
			},
		]);
		expect(fn.metadata.nameStringIndex).toBe(0);
		expect(createString.attributes.stringIndex).toBe(1);
		expect(createString.sourcePosition).toBe(1);
		expect(createBigint.attributes.bigintIndex).toBe(0);
		expect(createObject.attributes.keyStringIndices).toEqual([2, 0]);
		expect(instantiate.attributes.templateOffset).toBe(0);
		expect(switched).toMatchObject({
			kind: "switch",
			sourcePosition: 1,
			cases: [{ value: { kind: "string", index: 2 } }],
		});
		expect(() => verifyCoreProgram(compacted.program, coreOpcodeRegistry)).not.toThrow();
	});

	it("removes the body of a function retained only for observable identity", () => {
		const program = coreModule(
			`
				function identityOnly() { return 42; }
				globalThis.answer = identityOnly === identityOnly;
			`,
			true,
		);
		const identity = program.functions[1]!;
		const analysis = analyzeCoreFunctionReachability(program);
		const compacted = compactCoreProgramFunctions(program, analysis);
		const stub = compacted.program.functions[1]!;

		expect([...analysis.executable]).toEqual([0]);
		expect([...analysis.retained].sort((left, right) => left - right)).toEqual([0, 1]);
		expect(compacted.changed).toBe(true);
		expect(stub.metadata).toEqual(identity.metadata);
		expect(stub.blocks).toHaveLength(1);
		expect(stub.blocks[0]!.instructions.map(({ opcode }) => opcode)).toEqual([
			"createUndefined",
		]);
		expect(() => verifyCoreProgram(compacted.program, coreOpcodeRegistry)).not.toThrow();
	});

	it("traverses callees entered through direct Function.prototype.call dispatch", () => {
		const input = coreModule(
			`
					function dead() { return 0; }
					function leaf(value) { return value + 1; }
					function throughCall(value) { return leaf(value); }
					globalThis.answer = throughCall.call(undefined, 41);
				`,
			true,
		);
		const result = executeCoreOptimizations(input, {
			context: contextFor(input),
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		});
		const optimized = result.program;
		contexts.set(optimized, result.context!);
		const flattenedCall = optimized.functions[0]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ attributes }) => attributes.directFunctionCall === true);

		expect(optimized.functions).toHaveLength(3);
		expect(flattenedCall?.attributes.directCallTargetFunctionIndex).toBe(2);
		expect(() => verifyCoreProgram(optimized, coreOpcodeRegistry)).not.toThrow();
	});

	it("keeps every function when no graph proves source closure", () => {
		const program = coreModule(DEAD_CYCLE, false);
		const analysis = analyzeCoreFunctionReachability(program);
		const result = compactCoreProgramFunctions(program, analysis);

		expect(analysis.sourceClosed).toBe(false);
		expect(analysis.executable.size).toBe(program.functions.length);
		expect(analysis.retained.size).toBe(program.functions.length);
		expect(result).toMatchObject({ program, changed: false });
	});

	it("keeps finite script candidates without widening an opaque alternative", () => {
		const program = finitePlusOpaqueProgram();
		const analysis = analyzeCoreFunctionReachability(program);

		expect([...analysis.executable].sort((left, right) => left - right)).toEqual([0, 1]);
		expect([...analysis.retained].sort((left, right) => left - right)).toEqual([0, 1]);
		expect(compactCoreProgramFunctions(program, analysis).program.functions).toHaveLength(
			2,
		);
	});

	it("widens an any-script call edge to every in-image function", () => {
		const program = anyScriptProgram();
		const analysis = analyzeCoreFunctionReachability(program);

		expect(analysis.executable.size).toBe(program.functions.length);
		expect(analysis.retained.size).toBe(program.functions.length);
		expect(compactCoreProgramFunctions(program, analysis).changed).toBe(false);
	});

	it("keeps a CommonJS module wrapper as an explicit image entry", () => {
		const shell = closedProgram([leafFunction(0), leafFunction(1), leafFunction(2)]);
		const program: CoreProgram = { ...shell };
		const context = contextFor(shell);
		contexts.set(program, {
			...context,
			data: { ...context.data, cjsModuleFunctionIndices: [1] },
		});

		expect(
			[...analyzeCoreFunctionReachability(program).executable].sort(
				(left, right) => left - right,
			),
		).toEqual([0, 1]);
	});

	it("keeps functions exposed through host-installed global slots", () => {
		const analysis = analyzeCoreFunctionReachability(installedFunctionProgram("host"));

		expect([...analysis.executable].sort((left, right) => left - right)).toEqual([0, 1]);
		expect(analysis.reasons.get(1)).toContain("host-install");
	});

	it("keeps functions exposed through a reachable module namespace", () => {
		const analysis = analyzeCoreFunctionReachability(
			installedFunctionProgram("namespace"),
		);

		expect([...analysis.executable].sort((left, right) => left - right)).toEqual([0, 1]);
		expect(analysis.reasons.get(1)).toContain("module-namespace");
	});

	it("restores a removed summary's narrowed call result before verification", () => {
		const input = coreModule(
			`
          function live() { return 1.5; }
          globalThis.answer = live();
        `,
			true,
		);
		const optimization = executeCoreOptimizations(input, {
			context: contextFor(input),
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		});
		const optimized = optimization.program;
		contexts.set(optimized, optimization.context!);
		const expanded: CoreProgram = {
			...optimized,
			functions: [...optimized.functions, leafFunction(optimized.functions.length)],
		};
		contexts.set(expanded, contextFor(optimized));
		const compacted = compactCoreProgramFunctions(expanded);
		const call = compacted.program.functions[0]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ opcode }) => opcode === "call")!;

		expect(compacted.changed).toBe(true);
		expect(
			compacted.program.functions[0]!.values.find(({ id }) => id === call.outputs[0])!
				.representation,
		).toBe("boxed");
		expect(() => verifyCoreProgram(compacted.program, coreOpcodeRegistry)).not.toThrow();
		expect(() =>
			executeCoreOptimizations(expanded, {
				context: contextFor(expanded),
				ablations: new Set(["inlining", "interprocedural"]),
				verification: "per-pass",
			}),
		).not.toThrow();
	});

	it("retains inline source owners named only by a live optimization decision", () => {
		const shell = closedProgram([leafFunction(0), leafFunction(1), leafFunction(2)]);
		const program: CoreProgram = {
			...shell,
			sourcePositions: [
				{ line: 99, column: 9 },
				{ line: 1, column: 1, inlinedFunctionIndex: 2, callerPosId: 2 },
				{ line: 2, column: 1 },
			],
		};
		contexts.set(program, {
			...contextFor(shell),
			optimizationDecisions: [
				{
					functionIndex: 0,
					positionId: 1,
					operation: "call",
					phase: "optimization",
					code: "optimization.applied.test",
					outcome: "applied",
				},
			],
		});
		const analysis = analyzeCoreFunctionReachability(program);
		const compacted = compactCoreProgramFunctions(program, analysis);

		expect([...analysis.executable]).toEqual([0]);
		expect([...analysis.retained].sort((left, right) => left - right)).toEqual([0, 2]);
		expect(compacted.program.sourcePositions).toEqual([
			{ line: 1, column: 1, inlinedFunctionIndex: 1, callerPosId: 1 },
			{ line: 2, column: 1 },
		]);
		expect(compacted.context!.optimizationDecisions).toEqual([
			expect.objectContaining({ functionIndex: 0, positionId: 0 }),
		]);
	});

	it("rebases nested function scopes in retained builtin proofs", () => {
		const builder = new CoreFunctionBuilder(2, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Math" },
		});
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, receiver!], {
			attributes: {
				knownBuiltinCall: {
					identity: { proof: { scope: { kind: "function", id: 2 } } },
					semantics: { proof: { scope: { kind: "function", id: 2 } } },
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const shell = closedProgram([
			leafFunction(0),
			leafFunction(1),
			builder.finish(entry),
		]);
		const program: CoreProgram = { ...shell };
		const context = contextFor(shell);
		contexts.set(program, {
			...context,
			data: { ...context.data, cjsModuleFunctionIndices: [2] },
		});
		const compacted = compactCoreProgramFunctions(program);
		const known = compacted.program.functions[1]!.blocks.flatMap(
			({ instructions }) => instructions,
		)
			.map(({ attributes }) => attributes.knownBuiltinCall)
			.find((attribute) => attribute !== undefined);

		expect(compacted.program.functions).toHaveLength(2);
		expect(known).toMatchObject({
			identity: { proof: { scope: { kind: "function", id: 1 } } },
			semantics: { proof: { scope: { kind: "function", id: 1 } } },
		});
	});

	it("retracts target-facing shape hints during dense compaction", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createUndefined", []);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
			attributes: { keyStringIndices: [0] },
		});
		const shapeInstruction = builder.block(entry).instructions.at(-1)!.id;
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: {
				stringIndex: 0,
				[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: {
					candidates: [{ shapeFunctionIndex: 0, shapeInstruction, slot: 0 }],
				},
			},
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const compacted = compactCoreProgramFunctions(
			closedProgram([builder.finish(entry), leafFunction(1)]),
			{
				executable: new Set([0]),
				retained: new Set([0]),
				reasons: new Map([[0, new Set(["program-entry" as const])]]),
				sourceClosed: true,
			},
		);
		const load = compacted.program.functions[0]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ opcode }) => opcode === "loadPropertyStatic")!;

		expect(compacted.changed).toBe(true);
		expect(CORE_KNOWN_OWN_SLOT_ATTRIBUTE in load.attributes).toBe(false);
	});

	it("retracts graph-derived primitive certificates during dense compaction", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftNumber] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [rightNumber] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftNumber!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightNumber!] },
		});
		const number = builder.appendBlockParameter(join);
		const [one] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [result] = builder.appendInstruction(join, "binary", [number, one!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(join, { kind: "return", value: result! });
		const optimized = executeCoreOptimizations(closedProgram([builder.finish(entry)]), {
			verification: "per-pass",
		}).program.functions[0]!;
		expect(
			optimized.facts.some(({ kind }) => kind === CORE_PRIMITIVE_OPERATOR_EFFECT_FACT),
		).toBe(true);

		const compactedProgram = compactCoreProgramFunctions(
			closedProgram([optimized, leafFunction(1)]),
			{
				executable: new Set([0]),
				retained: new Set([0]),
				reasons: new Map([[0, new Set(["program-entry" as const])]]),
				sourceClosed: true,
			},
		).program;
		const compacted = compactedProgram.functions[0]!;
		const binary = compacted.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "binary")!;

		expect(
			compacted.facts.some(({ kind }) => kind === CORE_PRIMITIVE_OPERATOR_EFFECT_FACT),
		).toBe(false);
		expect(binary.effectRefinement).toBeUndefined();
		expect(CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE in binary.attributes).toBe(false);
		verifyCoreProgram(compactedProgram, coreOpcodeRegistry);
	});

	it("publishes the compact function table to VM lowering", () => {
		const path = "closed-reachability-product.mjs";
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(DEAD_CYCLE, path, parseModule(DEAD_CYCLE)),
			{
				facts: moduleFacts(path, true),
				optimizationAblations: new Set(["inlining"]),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		expect(optimized!.functions).toHaveLength(2);
		expect(definition.runtime.functionCount).toBe(2);
		expect(definition.runtime.functions).toHaveLength(2);
	});

	it("omits unreachable constants from the target program image", () => {
		const deadElements = Array.from({ length: 16 }, () => '"dead-metadata-only"').join(
			", ",
		);
		const source = `
			function dead() {
				return [${deadElements}, 9876543210123456789n];
			}
			globalThis.liveText = "live-metadata";
			globalThis.liveBigint = 1234567890123456789n;
		`;
		const path = "closed-metadata-product.mjs";
		const definition = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, path, parseModule(source)),
			{
				facts: moduleFacts(path, true),
				optimizationAblations: new Set(["inlining"]),
			},
		);
		const strings = definition.runtime.stringConstants.map((units) =>
			String.fromCharCode(...units),
		);

		expect(strings).toContain("live-metadata");
		expect(strings).not.toContain("dead-metadata-only");
		expect(definition.runtime.bigintConstants).toContain(1234567890123456789n);
		expect(definition.runtime.bigintConstants).not.toContain(9876543210123456789n);
		expect(definition.runtime.literalTemplateData).toEqual([]);
	});
});
