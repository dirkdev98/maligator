import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { formatCoreFunction } from "../src/compiler/core/core-ir.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import {
	buildCoreSpecializationRecipeTable,
	projectCoreSpecializationRecipes,
} from "../src/compiler/core/core-specialization-recipes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { coreRegisterClasses } from "../src/compiler/target/lower-execution.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { vmSafepointRootMapsAreTrusted } from "../src/compiler/target/runtime-image.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreFunctionParameters,
	inspectCoreInstructionOperands,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";
import {
	coreFunctionNamed,
	coreFunctions,
	coreOperations,
} from "./helpers/core-inspection.ts";

function construct(source: string) {
	return lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "core-lowering.js"),
	);
}

function lower(source: string) {
	return construct(source).program;
}

function optimize(source: string) {
	return optimizeCore(construct(source)).compilation;
}

describe("Core IR lowering", () => {
	it("constructs explicit SSA block parameters for mutable control flow", () => {
		const converted = lower(`
			function choose(flag) {
				let value = 1;
				if (flag) value = 2;
				else value = 3;
				return value;
			}
			choose(true);
		`);
		for (const fn of coreFunctions(converted)) {
			expect(() => verifyCoreFunction(converted, fn.id)).not.toThrow();
		}
		const printed = coreFunctions(converted)
			.map((fn) => formatCoreFunction(converted, fn.id))
			.join("\n");
		expect(printed).toMatch(/b\d+\(%\d+: boxed/);
		expect(printed).toContain("branch");
	});

	it("makes exceptional control flow explicit and round-trips to VM handlers", () => {
		const converted = lower(`
			function read(object) {
				let before = 4;
				try { return object.value + before; }
				catch (error) { return before + String(error).length; }
			}
			read({ value: 2 });
		`);
		const exceptional = coreFunctions(converted).flatMap((fn) =>
			[...fn.blockIds()].filter(
				(block) => inspectCoreBlockHandler(fn, block) !== undefined,
			),
		);
		expect(exceptional.length).toBeGreaterThan(0);

		const lowered = lowerCoreCompilationToExecution(
			optimize(`
				function read(object) {
					let before = 4;
					try { return object.value + before; }
					catch (error) { return before + String(error).length; }
				}
				read({ value: 2 });
			`),
		);
		const vm = lowerExecutionToProgramImage(lowered);
		expect(vm.runtime.functions.some(({ handlers }) => handlers.length > 0)).toBe(true);
	});

	it("does not lower unreachable structured handlers after abrupt completion", () => {
		const converted = lower(`
			function returned() { return; try {} catch (error) {} }
			function thrown() { throw 1; try {} catch (error) {} }
			function* generator() { throw 1; try {} catch (error) {} }
		`);
		for (const fn of coreFunctions(converted)) {
			expect(() => verifyCoreFunction(converted, fn.id)).not.toThrow();
		}
	});

	it("keeps preloaded handler values live and rooted across protected blocks", () => {
		const compilation = optimize(`
			function preserve(object, callback) {
				try {
					callback();
					return 0;
				} catch (error) {
					return object.value + String(error).length;
				}
			}
			preserve({ value: 2 }, () => { throw new Error("x"); });
		`);
		const fn = coreFunctionNamed(compilation.program, "preserve")!;
		expect(
			[...fn.blockIds()].some(
				(block) => inspectCoreBlockHandler(fn, block) !== undefined,
			),
		).toBe(true);
		const execution = lowerCoreCompilationToExecution(compilation);
		const executionFunction =
			execution.functions[execution.functionMap.coreToExecution[fn.id]!]!;
		const blockOrder = compilation.plan.blockOrders.find(
			(entry) => entry.function === fn.id,
		)!.blocks;
		const allocation = coreRegisterClasses(
			fn,
			true,
			new Set(inspectCoreFunctionParameters(fn).keys()),
			blockOrder,
		);
		const object = inspectCoreFunctionParameters(fn)[0]!;
		const objectRegister = allocation.registers.get(object);
		expect(objectRegister).toBeDefined();

		expect(
			executionFunction.gc.safepoints.some(({ rootRegisters }) =>
				rootRegisters.includes(objectRegister!),
			),
		).toBe(true);
	});

	it("roots values consumed by outgoing edges after a GC safepoint", () => {
		const compilation = optimize(`
			function preserve(value, callback) {
				callback();
				if (Date.now()) return value;
				return value;
			}
			preserve({ tag: "held" }, () => 0);
		`);
		const fn = coreFunctionNamed(compilation.program, "preserve")!;
		const execution = lowerCoreCompilationToExecution(compilation);
		const executionFunction =
			execution.functions[execution.functionMap.coreToExecution[fn.id]!]!;

		expect(
			executionFunction.gc.safepoints.some(({ rootRegisters }) =>
				rootRegisters.includes(0),
			),
		).toBe(true);
	});

	it("lowers virtual-field root uses into safepoint metadata without an opcode", () => {
		const compilation = optimize(`
				function preserve(value) {
					const object = { held: value };
					globalThis.observe();
					object.held = 0;
					return 1;
				}
			`);
		const core = coreFunctions(compilation.program).find((fn) =>
			coreOperations(fn).some(({ opcode }) => opcode === "rootUse"),
		)!;
		const target = lowerCoreCompilationToExecution(compilation);
		const functionIndex = target.functionMap.coreToExecution[core.id]!;
		const fn = target.functions[functionIndex]!;
		const instructions = fn.blocks.flatMap(({ instructions }) => instructions);
		const callSite = fn.blocks
			.flatMap((block) =>
				block.instructions.flatMap((instruction, index) => {
					if (instruction.type !== "rootUse") return [];
					const previous = block.instructions[index - 1];
					return previous?.type === "call"
						? [{ marker: instruction, call: previous }]
						: [];
				}),
			)
			.at(0);
		expect(callSite?.marker.type).toBe("rootUse");
		if (callSite === undefined) return;
		const marker = callSite.marker;
		const safepoint = fn.gc.safepoints.find(
			(candidate) => candidate.instruction === callSite.call,
		);
		expect(safepoint?.rootRegisters).toContain(marker.registers[0]);

		const executableCount = instructions.filter(
			({ type }) =>
				type !== "sourcePos" &&
				type !== "rootUse" &&
				type !== "tryBegin" &&
				type !== "tryEnd",
		).length;
		const vm = lowerExecutionToProgramImage(target);
		expect(vm.runtime.functions[functionIndex]!.instructions).toHaveLength(
			executableCount,
		);
	});

	it("roots a virtual-field parameter at a post-join safepoint", () => {
		const compilation = optimize(`
				function preserve(initial, left, right, chooseLeft) {
					const object = { held: initial };
					if (chooseLeft) object.held = left;
					else object.held = right;
					globalThis.observe();
					object.held = 0;
					return 1;
				}
			`);
		const core = coreFunctions(compilation.program).find((fn) =>
			coreOperations(fn).some(({ opcode }) => opcode === "rootUse"),
		)!;
		const rooted = coreOperations(core).find(({ opcode }) => opcode === "rootUse")!
			.inputs[0]!;
		expect(inspectCoreValueDefinition(core, rooted).kind).toBe("block-parameter");

		const target = lowerCoreCompilationToExecution(compilation);
		const fn = target.functions[target.functionMap.coreToExecution[core.id]!]!;
		const callSite = fn.blocks
			.flatMap((block) =>
				block.instructions.flatMap((instruction, index) => {
					if (instruction.type !== "rootUse") return [];
					const previous = block.instructions[index - 1];
					return previous?.type === "call"
						? [{ marker: instruction, call: previous }]
						: [];
				}),
			)
			.at(0);
		expect(callSite).toBeDefined();
		if (callSite === undefined) return;
		const safepoint = fn.gc.safepoints.find(
			(candidate) => candidate.instruction === callSite.call,
		);
		expect(safepoint?.rootRegisters).toContain(callSite.marker.registers[0]);
	});

	it("roots a loop-carried virtual-field parameter at an in-loop safepoint", () => {
		const compilation = optimize(`
				function preserve(initial, replacement, count) {
					const object = { held: initial };
					for (let index = 0; index < count; index++) {
						globalThis.observe();
						object.held = replacement;
					}
					return object.held;
				}
			`);
		const core = coreFunctions(compilation.program).find((fn) =>
			coreOperations(fn).some(({ opcode }) => opcode === "rootUse"),
		)!;
		const rooted = coreOperations(core).find(({ opcode }) => opcode === "rootUse")!
			.inputs[0]!;
		expect(inspectCoreValueDefinition(core, rooted).kind).toBe("block-parameter");

		const target = lowerCoreCompilationToExecution(compilation);
		const fn = target.functions[target.functionMap.coreToExecution[core.id]!]!;
		const callSite = fn.blocks
			.flatMap((block) =>
				block.instructions.flatMap((instruction, index) => {
					if (instruction.type !== "rootUse") return [];
					const previous = block.instructions[index - 1];
					return previous?.type === "call"
						? [{ marker: instruction, call: previous }]
						: [];
				}),
			)
			.at(0);
		expect(callSite).toBeDefined();
		if (callSite === undefined) return;
		const safepoint = fn.gc.safepoints.find(
			(candidate) => candidate.instruction === callSite.call,
		);
		expect(safepoint?.rootRegisters).toContain(callSite.marker.registers[0]);
	});

	it("carries a virtual field through a suspension safepoint", () => {
		const compilation = optimize(`
				function* preserve(value) {
					const object = { held: value };
					yield 0;
					object.held = 0;
					return 1;
				}
			`);
		const core = coreFunctions(compilation.program).find((fn) =>
			coreOperations(fn).some(({ opcode }) => opcode === "rootUse"),
		)!;
		const target = lowerCoreCompilationToExecution(compilation);
		const fn = target.functions[target.functionMap.coreToExecution[core.id]!]!;
		const suspension = fn.blocks
			.flatMap((block) =>
				block.instructions.flatMap((instruction, index) => {
					if (instruction.type !== "rootUse") return [];
					const previous = block.instructions[index - 1];
					return previous?.type === "yield"
						? [{ marker: instruction, yield: previous }]
						: [];
				}),
			)
			.at(0);
		expect(suspension).toBeDefined();
		if (suspension === undefined) return;
		const safepoint = fn.gc.safepoints.find(
			(candidate) => candidate.instruction === suspension.yield,
		);
		expect(safepoint?.rootRegisters).toContain(suspension.marker.registers[0]);
	});

	it("carries a virtual field through an exceptional safepoint", () => {
		const compilation = optimize(`
				function preserve(value, callback) {
					const object = { held: value };
					try {
						callback();
					} catch (error) {
						globalThis.observe();
						object.held = 0;
						return 1;
					}
					object.held = 0;
					return 1;
				}
			`);
		const core = coreFunctions(compilation.program).find((fn) =>
			[...fn.blockIds()].some(
				(block) => inspectCoreBlockHandler(fn, block) !== undefined,
			),
		)!;
		const protectedBlock = [...core.blockIds()].find(
			(block) => inspectCoreBlockHandler(core, block) !== undefined,
		)!;
		const handler = inspectCoreBlockHandler(core, protectedBlock)!;
		const handlerParameters = inspectCoreBlockParameters(core, handler.block);
		const field = handlerParameters.at(-1)!.value;
		expect(handlerParameters[0]?.role).toBe("exception");
		expect(
			[...core.bodyInstructionIds(handler.block)].some(
				(instruction) =>
					core.instructionOpcodeName(instruction) === "rootUse" &&
					inspectCoreInstructionOperands(core, instruction).includes(field),
			),
		).toBe(true);

		const target = lowerCoreCompilationToExecution(compilation);
		const fn = target.functions[target.functionMap.coreToExecution[core.id]!]!;
		const call = [...core.bodyInstructionIds(protectedBlock)].find(
			(instruction) => core.instructionOpcodeName(instruction) === "call",
		)!;
		const safepoint = fn.gc.safepoints.find(
			(candidate) => candidate.kind === "operation" && candidate.coreInstruction === call,
		);
		expect(safepoint?.rootRegisters).toContain(0);
	});

	it("reuses registers for values live on disjoint CFG branches", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const leftStart = builder.createBlock();
		const right = builder.createBlock();
		const leftEnd = builder.createBlock([{ representation: "f64" }]);
		const merge = builder.createBlock([{ representation: "f64" }]);
		const [left] = builder.appendInstruction(leftStart, "createF64", [], {
			attributes: { value: 1 },
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: inspectCoreBlockParameters(builder, entry)[0]!.value,
			consequent: { block: leftStart, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(leftStart, {
			kind: "jump",
			edge: { block: leftEnd, arguments: [left!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [rightValue!] },
		});
		builder.setTerminator(leftEnd, {
			kind: "jump",
			edge: {
				block: merge,
				arguments: [inspectCoreBlockParameters(builder, leftEnd)[0]!.value],
			},
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, merge)[0]!.value,
		});
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);
		const allocation = coreRegisterClasses(fn, true);
		const register = (value: NonNullable<typeof left>): number =>
			allocation.registers.get(allocation.roots.get(value) ?? value)!;

		expect(register(left!)).toBe(register(rightValue!));
	});

	it("reuses a dying input register for a same-representation result", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [left] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [right] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 2 },
			outputRepresentations: ["f64"],
		});
		const [result] = builder.appendInstruction(entry, "binary", [left!, right!], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const { function: functionId } = builder.finish(entry);
		const allocation = coreRegisterClasses(program.function(functionId), true);
		const register = (value: CoreValueId): number => allocation.registers.get(value)!;

		expect(register(result!)).toBe(register(left!));
		expect(register(right!)).not.toBe(register(left!));
	});

	it("round-trips loops, calls, and multiple-result operations to VM form", () => {
		const compilation = optimize(`
			let total = 0;
			for (const value of [1, 2, 3]) total += value;
			console.log(total);
		`);
		const lowered = lowerCoreCompilationToExecution(compilation);
		const vm = lowerExecutionToProgramImage(lowered);
		expect(vm.runtime.functions.length).toBeGreaterThan(0);
		expect(
			vm.runtime.functions.flatMap(({ instructions }) => instructions).length,
		).toBeGreaterThan(10);
		const exactFunctions = vm.runtime.functions.filter(
			(fn) => vmSafepointRootMapsAreTrusted(fn) && (fn.gcSafepoints?.length ?? 0) > 0,
		);
		expect(exactFunctions.length).toBeGreaterThan(0);
		expect(
			exactFunctions.some((fn) =>
				fn.gcSafepoints!.some(
					(safepoint) => safepoint.rootRegisters.length < fn.registerCount,
				),
			),
		).toBe(true);
	});

	it("resolves known shaped origins to dense VM cache rows", () => {
		const compilation = optimize(`
				function read(n, touch) {
					const object = { x: n };
					let sum = 0;
					for (let index = 0; index < n; index++) {
						touch(object);
						sum += object.x;
					}
					return sum;
				}
				read(3, () => {});
			`);
		const target = lowerCoreCompilationToExecution(compilation);
		const vm = lowerExecutionToProgramImage(target);
		const load = vm.runtime.functions
			.flatMap((fn) => fn.instructions)
			.find(
				(instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			);
		expect(load?.opcode).toBe("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		if (load?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT") return;
		const candidate = load.candidates[0]!;
		const source = vm.runtime.functions[candidate.shapeFunctionIndex]!.instructions.find(
			(instruction) =>
				instruction.opcode === "CREATE_OBJECT_SHAPED" &&
				instruction.shapeCacheIndex === candidate.shapeCacheIndex,
		);
		expect(source?.opcode).toBe("CREATE_OBJECT_SHAPED");
		if (source?.opcode !== "CREATE_OBJECT_SHAPED") return;
		expect(source.keyStringIndices[candidate.slot]).toBe(load.stringIndex);

		const targetLoad = target.functions
			.flatMap((fn) => fn.blocks)
			.flatMap((block) => block.instructions)
			.find(
				(instruction) =>
					instruction.type === "loadPropertyStatic" && instruction.knownOwnSlot,
			);
		if (targetLoad?.type !== "loadPropertyStatic" || !targetLoad.knownOwnSlot) {
			throw new Error("expected selected target load");
		}
		const original = targetLoad.knownOwnSlot;
		const mutable = targetLoad as {
			knownOwnSlot: {
				candidates: ReadonlyArray<{
					shapeFunctionIndex: number;
					shapeInstruction: number;
					slot: number;
				}>;
			};
		};
		mutable.knownOwnSlot = {
			candidates: [
				{
					...original.candidates[0]!,
					shapeInstruction: Number.MAX_SAFE_INTEGER,
				},
			],
		};
		try {
			expect(() => lowerExecutionToProgramImage(target)).toThrow(
				/Invalid known-own-slot access origin/,
			);
		} finally {
			mutable.knownOwnSlot = original;
		}
	});

	it("resolves guarded shaped stores to dense VM cache rows", () => {
		const compilation = optimize(`
				function write(n, touch) {
					const object = { x: 0 };
					for (let index = 0; index < n; index++) {
						touch(object);
						object.x = index;
					}
					return object.x;
				}
				write(3, () => {});
			`);
		const target = lowerCoreCompilationToExecution(compilation);
		const vm = lowerExecutionToProgramImage(target);
		const store = vm.runtime.functions
			.flatMap((fn) => fn.instructions)
			.find(
				(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			);
		expect(store?.opcode).toBe("STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		if (store?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") return;
		const candidate = store.candidates[0]!;
		const source = vm.runtime.functions[candidate.shapeFunctionIndex]!.instructions.find(
			(instruction) =>
				instruction.opcode === "CREATE_OBJECT_SHAPED" &&
				instruction.shapeCacheIndex === candidate.shapeCacheIndex,
		);
		expect(source?.opcode).toBe("CREATE_OBJECT_SHAPED");
		if (source?.opcode !== "CREATE_OBJECT_SHAPED") return;
		expect(source.keyStringIndices[candidate.slot]).toBe(store.stringIndex);
	});

	it("rejects a malformed selected Core plan at the optimizer boundary", () => {
		const compilation = optimize(`
			function choose(value, escape) {
				const object = { value };
				if (escape) return object;
				return object.value;
			}
			choose(1, true);
		`);
		const specializations = projectCoreSpecializationRecipes(compilation.plan.recipes);
		const selection = specializations.find(({ kind }) => kind === "stack-object-plan");
		expect(selection).toBeDefined();
		if (selection === undefined) return;
		const malformed = {
			...compilation.plan,
			recipes: buildCoreSpecializationRecipeTable(
				specializations.map((candidate) =>
					candidate === selection
						? { ...candidate, cost: { ...candidate.cost, generatedCode: -1 } }
						: candidate,
				),
			),
		};
		expect(() => verifyCoreOptimizationPlan(compilation.program, malformed)).toThrow(
			/has invalid generatedCode cost/,
		);
	});

	it("models captured private-name batches as result-free writes", () => {
		const converted = lower(`
			function make() {
				return class { #value; read() { return this.#value; } };
			}
			make();
		`);
		const batches = coreFunctions(converted).flatMap((fn) =>
			coreOperations(fn).filter(({ opcode }) => opcode === "createPrivateNames"),
		);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.outputs).toEqual([]);
		expect(coreOpcodeRegistry.require("createPrivateNames").effects.writes).toContain(
			"captured-slot",
		);
	});

	it("represents call operands as explicit SSA producers", () => {
		const converted = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`
				function invoke(fn) {
					return fn(undefined, null, false, 42, "value");
				}
				globalThis.invoke = invoke;
				`,
				"core-immediates.js",
			),
		).program;
		const call = coreFunctions(converted)
			.flatMap(coreOperations)
			.find(
				(instruction) => instruction.opcode === "call" && instruction.inputs.length > 2,
			);

		expect(call?.inputs).toHaveLength(7);
		expect(call?.attributes).not.toHaveProperty("immediateValues");
		const opcodes = coreFunctions(converted).flatMap((fn) =>
			coreOperations(fn).map(({ opcode }) => opcode),
		);
		expect(opcodes).toEqual(
			expect.arrayContaining([
				"createUndefined",
				"createNull",
				"createBoolean",
				"createNumber",
				"createString",
			]),
		);
	});

	it("lowers Core switches with strict-equality case selection", () => {
		const constructed = construct(`
			function pick(value) {
				if (value) return 1;
				return 2;
			}
			pick(true);
		`);
		const owner = coreFunctions(constructed.program).find((fn) =>
			[...fn.blockIds()].some(
				(block) =>
					inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)).kind === "branch",
			),
		)!;
		const block = [...owner.blockIds()].find(
			(candidate) =>
				inspectCoreTerminatorPayload(owner, owner.blockTerminator(candidate)).kind ===
				"branch",
		)!;
		const branch = inspectCoreTerminatorPayload(owner, owner.blockTerminator(block));
		if (branch.kind !== "branch") throw new Error("missing branch fixture");
		const editor = CoreEditor.open(constructed.program, owner.id);
		editor.replaceTerminator(block, {
			kind: "switch",
			discriminant: branch.condition,
			cases: [
				{
					value: { kind: "boolean", value: true },
					edge: branch.consequent,
				},
			],
			default: branch.alternate,
		});
		editor.commit();
		const compilation = optimizeCore(constructed).compilation;
		const lowered = lowerCoreCompilationToExecution(compilation);
		const executionIndex = lowered.functionMap.coreToExecution[owner.id]!;
		const instructions = lowered.functions[executionIndex]!.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(instructions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "createBoolean", value: true }),
				expect.objectContaining({ type: "binary", operator: "===" }),
			]),
		);
	});

	it("satisfies the explicit-super two-address constraint by coalescing or moves", () => {
		const compilation = optimize(`
			class Parent {}
			class Child extends Parent {
				constructor() {
					super();
					this.repeat = () => super();
				}
			}
			new Child();
		`);
		const lowered = lowerCoreCompilationToExecution(compilation);
		const instructions = lowered.functions
			.flatMap((fn) => fn.blocks.flatMap((block) => block.instructions))
			.filter(
				({ type }) =>
					type !== "sourcePos" &&
					type !== "rootUse" &&
					type !== "tryBegin" &&
					type !== "tryEnd",
			);
		const constructIndexes = instructions.flatMap((instruction, index) =>
			instruction.type === "constructSuperExplicit" ? [index] : [],
		);
		expect(constructIndexes.length).toBeGreaterThan(0);
		for (const constructIndex of constructIndexes) {
			const construct = instructions[constructIndex]!;
			if (construct.type !== "constructSuperExplicit") {
				throw new Error("missing explicit super construction");
			}

			const constrained = construct.registers[0];
			expect(construct.registers[4]).toBe(constrained);
			expect(construct.registers.slice(1, 4)).not.toContain(constrained);

			const inputMove = instructions[constructIndex - 1]!;
			if (inputMove.type === "move") {
				expect(inputMove.registers[0]).toBe(constrained);
			} else if (inputMove.type === "loadPropertyStatic") {
				expect(inputMove.registers[0]).toBe(constrained);
			} else {
				throw new Error("missing target-constraint input definition");
			}

			const resultMove = instructions[constructIndex + 1]!;
			if (resultMove.type === "move") {
				expect(resultMove.registers[1]).toBe(constrained);
			} else {
				expect(inputMove.type).toBe("loadPropertyStatic");
			}
		}
	});
});
