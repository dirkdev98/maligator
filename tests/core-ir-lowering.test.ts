import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder, formatCoreFunction } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { coreRegisterClasses } from "../src/compiler/target/lower-execution.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { vmSafepointRootMapsAreTrusted } from "../src/compiler/target/runtime-image.ts";
import { coreCompilationForTest } from "./helpers/core-compilation.ts";

function lower(source: string) {
	return lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "core-lowering.js"),
	).program;
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
		for (const fn of converted.functions) {
			expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		}
		const printed = converted.functions.map((fn) => formatCoreFunction(fn)).join("\n");
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
		const exceptional = converted.functions.flatMap((fn) =>
			fn.blocks.filter(({ handler }) => handler !== undefined),
		);
		expect(exceptional.length).toBeGreaterThan(0);

		const lowered = lowerCoreCompilationToExecution(coreCompilationForTest(converted));
		const vm = lowerExecutionToProgramImage(lowered);
		expect(vm.runtime.functions.some(({ handlers }) => handlers.length > 0)).toBe(true);
	});

	it("does not lower unreachable structured handlers after abrupt completion", () => {
		const converted = lower(`
			function returned() { return; try {} catch (error) {} }
			function thrown() { throw 1; try {} catch (error) {} }
			function* generator() { throw 1; try {} catch (error) {} }
		`);
		for (const fn of converted.functions) {
			expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		}
	});

	it("keeps preloaded handler values live and rooted across protected blocks", () => {
		const converted = lower(`
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
		const fn = converted.functions.find((candidate) =>
			candidate.blocks.some(({ handler }) => handler !== undefined),
		)!;
		const protectedBlock = fn.blocks.find(({ handler }) => handler !== undefined)!;
		const target = fn.blocks[protectedBlock.handler!.block]!;
		const handlerValue = target.parameters[1]!.value;
		const allocation = coreRegisterClasses(fn, true);
		const register = (value: typeof handlerValue): number =>
			allocation.registers.get(allocation.roots.get(value)!)!;
		const handlerRegister = register(handlerValue);
		const clobbers = protectedBlock.instructions.flatMap(({ outputs }) => outputs);
		const execution = lowerCoreCompilationToExecution(coreCompilationForTest(converted));
		const executionFunction = execution.functions[fn.functionIndex]!;

		expect(clobbers.map(register)).not.toContain(handlerRegister);
		expect(
			executionFunction.gc.safepoints.some(({ rootRegisters }) =>
				rootRegisters.includes(handlerRegister),
			),
		).toBe(true);
	});

	it("roots values consumed by outgoing edges after a GC safepoint", () => {
		const converted = lower(`
			function preserve(value, callback) {
				callback();
				if (Date.now()) return value;
				return value;
			}
			preserve({ tag: "held" }, () => 0);
		`);
		const fn = converted.functions.find(
			(candidate) => candidate.parameters.length === 2,
		)!;
		const protectedBlock = fn.blocks.find(
			(block) =>
				block.terminator.kind === "branch" &&
				block.instructions.some(
					(instruction) => coreOpcodeRegistry.require(instruction.opcode).effects.mayGc,
				),
		)!;
		if (protectedBlock.terminator.kind !== "branch") {
			throw new Error("expected branch terminator");
		}
		const edgeValue = protectedBlock.terminator.consequent.arguments[0]!;
		const allocation = coreRegisterClasses(fn, true);
		const edgeRegister = allocation.registers.get(allocation.roots.get(edgeValue)!)!;
		const execution = lowerCoreCompilationToExecution(coreCompilationForTest(converted));
		const executionFunction = execution.functions[fn.functionIndex]!;

		expect(
			executionFunction.gc.safepoints.some(({ rootRegisters }) =>
				rootRegisters.includes(edgeRegister),
			),
		).toBe(true);
	});

	it("lowers virtual-field root uses into safepoint metadata without an opcode", () => {
		const optimized = executeCoreOptimizations(
			lower(`
				function preserve(value) {
					const object = { held: value };
					globalThis.observe();
					object.held = 0;
					return 1;
				}
			`),
		).program;
		const core = optimized.functions.find((fn) =>
			fn.blocks.some((block) =>
				block.instructions.some(({ opcode }) => opcode === "rootUse"),
			),
		)!;
		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
		const fn = target.functions[core.functionIndex]!;
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
		expect(vm.runtime.functions[core.functionIndex]!.instructions).toHaveLength(
			executableCount,
		);
	});

	it("reuses registers for values live on disjoint CFG branches", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
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
			condition: builder.block(entry).parameters[0]!.value,
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
				arguments: [builder.block(leftEnd).parameters[0]!.value],
			},
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: builder.block(merge).parameters[0]!.value,
		});
		const fn = builder.finish(entry);
		const allocation = coreRegisterClasses(fn, true);
		const register = (value: NonNullable<typeof left>): number =>
			allocation.registers.get(allocation.roots.get(value)!)!;

		expect(register(left!)).toBe(register(rightValue!));
	});

	it("round-trips loops, calls, and multiple-result operations to VM form", () => {
		const converted = lower(`
			let total = 0;
			for (const value of [1, 2, 3]) total += value;
			console.log(total);
		`);
		const lowered = lowerCoreCompilationToExecution(coreCompilationForTest(converted));
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
		const optimized = executeCoreOptimizations(
			lower(`
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
			`),
			{ ablations: new Set(["inlining", "interprocedural"]) },
		).program;
		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
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
		const optimized = executeCoreOptimizations(
			lower(`
				function write(n, touch) {
					const object = { x: 0 };
					for (let index = 0; index < n; index++) {
						touch(object);
						object.x = index;
					}
					return object.x;
				}
				write(3, () => {});
			`),
			{ ablations: new Set(["inlining", "interprocedural"]) },
		).program;
		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
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

	it("rejects a malformed selected Core region instead of dropping it", () => {
		const compilation = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`
					function project(value) {
						const fields = value.split(";");
						return fields[1] + fields.length;
					}
					project("a;b");
				`,
				"core-lowering.js",
			),
		);
		const optimized = executeCoreOptimizations(compilation.program, {
			context: compilation.context,
		}).program;
		const functionIndex = optimized.functions.findIndex(({ regions }) =>
			regions.some(({ kind }) => kind === "string-split-projection"),
		);
		const owner = optimized.functions[functionIndex]!;
		const regionIndex = owner.regions.findIndex(
			({ kind }) => kind === "string-split-projection",
		);
		const region = owner.regions[regionIndex]!;
		const cost = region.data.cost as { readonly score: number };
		const malformed = {
			...optimized,
			functions: optimized.functions.with(functionIndex, {
				...owner,
				regions: owner.regions.with(regionIndex, {
					...region,
					data: {
						...region.data,
						cost: { score: cost.score, metadataOperations: 0 },
					},
				}),
			}),
		};
		const allocated = lowerCoreCompilationToExecution(coreCompilationForTest(malformed));
		expect(() => lowerExecutionToProgramImage(allocated)).toThrow(
			/Invalid Core string-split-projection region during VM lowering/,
		);
	});

	it("models captured private-name batches as result-free writes", () => {
		const converted = lower(`
			function make() {
				return class { #value; read() { return this.#value; } };
			}
			make();
		`);
		const batches = converted.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) =>
				block.instructions.filter(({ opcode }) => opcode === "createPrivateNames"),
			),
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
		const call = converted.functions
			.flatMap((fn) => fn.blocks)
			.flatMap((block) => block.instructions)
			.find(
				(instruction) => instruction.opcode === "call" && instruction.inputs.length > 2,
			);

		expect(call?.inputs).toHaveLength(7);
		expect(call?.attributes).not.toHaveProperty("immediateValues");
		const opcodes = converted.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
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
		const converted = lower(`
			function pick(value) {
				if (value) return 1;
				return 2;
			}
			pick(true);
		`);
		const functionIndex = converted.functions.findIndex((fn) =>
			fn.blocks.some(({ terminator }) => terminator.kind === "branch"),
		);
		const fn = converted.functions[functionIndex]!;
		const blockIndex = fn.blocks.findIndex(
			({ terminator }) => terminator.kind === "branch",
		);
		const block = fn.blocks[blockIndex]!;
		if (block.terminator.kind !== "branch") throw new Error("missing branch fixture");
		const switchBlock = {
			...block,
			terminator: {
				id: block.terminator.id,
				kind: "switch" as const,
				discriminant: block.terminator.condition,
				cases: [
					{
						value: { kind: "boolean" as const, value: true },
						edge: block.terminator.consequent,
					},
				],
				default: block.terminator.alternate,
			},
		};
		const switched = {
			...converted,
			functions: converted.functions.map((candidate, index) =>
				index === functionIndex
					? {
							...candidate,
							blocks: candidate.blocks.map((candidateBlock, index) =>
								index === blockIndex ? switchBlock : candidateBlock,
							),
						}
					: candidate,
			),
		};

		const lowered = lowerCoreCompilationToExecution(coreCompilationForTest(switched));
		const instructions = lowered.functions[functionIndex]!.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(instructions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "createBoolean", value: true }),
				expect.objectContaining({ type: "binary", operator: "===" }),
			]),
		);
	});

	it("lowers explicit super current-this through the VM two-address constraint", () => {
		const converted = lower(`
			class Parent {}
			class Child extends Parent {
				constructor() {
					super();
					this.repeat = () => super();
				}
			}
			new Child();
		`);
		const lowered = lowerCoreCompilationToExecution(
			coreCompilationForTest(executeCoreOptimizations(converted).program),
		);
		const instructions = lowered.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) => block.instructions),
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
			expect(inputMove.type).toBe("move");
			if (inputMove.type !== "move") {
				throw new Error("missing target-constraint input move");
			}
			expect(inputMove.registers[0]).toBe(constrained);

			const resultMove = instructions[constructIndex + 1]!;
			expect(resultMove.type).toBe("move");
			if (resultMove.type !== "move") {
				throw new Error("missing target-constraint result move");
			}
			expect(resultMove.registers[1]).toBe(constrained);
		}
	});
});
