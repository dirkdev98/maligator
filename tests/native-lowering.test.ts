import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { nativeLoopBackedgeInstructions } from "../src/compiler/target/execution-liveness.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import {
	createConservativeNativePlan,
	nativeFrameRootRegisters,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

const source = `
function calculate(value) {
 const first = value + 1;
 globalThis.observe(first);
 const second = value + 2;
 globalThis.observe(second);
 return value + 3;
}
globalThis.calculate = calculate;
`;

describe("SSA native lowering", () => {
	it("requires boxed locals and outgoing maps at every native suspension transfer", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.suspend = async function* (value) {
					await globalThis.gate;
					yield value;
					return value;
				};`,
				"/native-suspension-contract.js",
			),
		);
		const fn = image.native.functions.find((native) => native.mode === "resumable")!;
		expect(() => nativeFrameRootRegisters(fn.body, fn)).not.toThrow();
		expect(() =>
			nativeFrameRootRegisters(fn.body, {
				...fn,
				registerRepresentations: fn.registerRepresentations.map((rep, index) =>
					index === 0 ? "number" : rep,
				),
			}),
		).toThrow("resumable native locals must retain boxed representations");
		for (const opcode of ["GENERATOR_START", "YIELD", "AWAIT"]) {
			const ip = fn.body.instructions.findIndex((op) => op.opcode === opcode);
			expect(ip).toBeGreaterThanOrEqual(0);
			expect(() =>
				nativeFrameRootRegisters(fn.body, {
					...fn,
					gc: {
						safepoints: fn.gc.safepoints.filter((point) => point.instructionIp !== ip),
					},
				}),
			).toThrow("native suspension transfer lacks an outgoing GC map");
		}
	});

	it("does not poll acyclic phi-copy transfers", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.choose = (condition, left, right) => {
					let value;
					if (condition) value = left; else value = right;
					globalThis.observe(value);
					return value;
				};`,
				"/acyclic-phi.js",
			),
		);
		const native = image.native.functions[1]!;
		expect(
			native.body.instructions.some(
				(instruction, ip) => instruction.opcode === "JUMP" && instruction.targetIp <= ip,
			),
		).toBe(true);
		expect(
			native.gc.safepoints.filter((point) => point.kind === "loop-backedge"),
		).toEqual([]);
		for (const [ip, instruction] of image.runtime.functions[1]!.instructions.entries()) {
			if (
				(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
				instruction.targetIp <= ip
			)
				expect(
					image.runtime.functions[1]!.gcSafepoints?.map((point) => point.instructionIp),
				).toContain(ip);
		}
		expect(() => emitProgramImage(image, { compiled: true })).not.toThrow();
	});

	it("requires cycle polling in native artifacts", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.repeat = (value, count) => {
					while (count-- > 0) globalThis.observe(value);
					return value;
				};`,
				"/cyclic-phi.js",
			),
		);
		const fn = image.native.functions[1]!;
		const polls = fn.gc.safepoints.filter((point) => point.kind === "loop-backedge");
		expect(polls.length).toBeGreaterThan(0);
		expect(polls.some((point) => point.rootRegisters.length > 0)).toBe(true);
		expect(() =>
			nativeFrameRootRegisters(fn.body, {
				...fn,
				gc: {
					safepoints: fn.gc.safepoints.filter((point) => point.kind !== "loop-backedge"),
				},
			}),
		).toThrow("native control-flow cycle has no polling edge");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.gc).toEqual(fn.gc);
	});

	it.each([
		"try { globalThis.thrower(); return; } catch { globalThis.observe(); }",
		"try { throw globalThis.value; } catch (error) { globalThis.observe(error); }",
	])("polls cycles through exception handlers: %s", (body) => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.retry = () => { while (true) { ${body} } };`,
				"/exception-cycle.js",
			),
		);
		const fn = image.native.functions[1]!;
		expect(fn.body.handlers.length).toBeGreaterThan(0);
		expect(fn.gc.safepoints.some((point) => point.kind === "loop-backedge")).toBe(true);
		expect(() =>
			nativeFrameRootRegisters(fn.body, {
				...fn,
				gc: {
					safepoints: fn.gc.safepoints.filter((point) => point.kind !== "loop-backedge"),
				},
			}),
		).toThrow("native control-flow cycle has no polling edge");
		expect(() =>
			emitProgramImage(deserializeCompilerArtifact(serializeCompilerArtifact(image)), {
				compiled: true,
			}),
		).not.toThrow();
	});

	it("polls physically forward cycle edges and every handler component", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis("globalThis.value = 1;", "/cycle-layout.js"),
		);
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis("globalThis.value = 1;", "/cycle-layout.js"),
			{},
			(_phase, run) => run(),
		);
		const fn = lowerCoreCompilationToNativeProgram(core).functions[0]!;
		const forward = { type: "jump" as const, blocks: [2] as [number] };
		const handlerLoop = { type: "jump" as const, blocks: [4] as [number] };
		expect(
			nativeLoopBackedgeInstructions({
				...fn,
				blocks: [
					{
						instructions: [
							{ type: "tryBegin", blocks: [3, 0] },
							{ type: "jump", blocks: [2] },
							{ type: "tryEnd" },
						],
					},
					{ instructions: [forward] },
					{ instructions: [{ type: "jump", blocks: [1] }] },
					{
						instructions: [
							{ type: "catch", registers: [0] },
							{ type: "jump", blocks: [4] },
						],
					},
					{ instructions: [handlerLoop] },
				],
			}),
		).toEqual(new Set([forward, handlerLoop]));
		const body = {
			...image.native.functions[0]!.body,
			instructions: [
				{ opcode: "JUMP" as const, targetIp: 2 },
				{ opcode: "JUMP" as const, targetIp: 2 },
				{ opcode: "JUMP" as const, targetIp: 1 },
			],
		};
		const conservative = createConservativeNativePlan([body]).functions[0]!;
		const native = {
			...conservative,
			gc: {
				safepoints: conservative.gc.safepoints.map((point) => ({
					...point,
					kind:
						point.instructionIp === 1
							? ("loop-backedge" as const)
							: ("conservative" as const),
				})),
			},
		};
		expect(() => nativeFrameRootRegisters(body, native)).not.toThrow();
		const output = emitCompiledFunction(native, 0, "", false)?.source;
		expect(output).toMatch(/L1:;\s+if \(mal_gc_poll\)/);
		const left = {
			type: "jumpIf" as const,
			registers: [0] as [number],
			blocks: [2] as [number],
		};
		const right = { type: "jump" as const, blocks: [3] as [number] };
		expect(
			nativeLoopBackedgeInstructions({
				...fn,
				blocks: [
					{
						instructions: [
							{ type: "tryBegin", blocks: [1, 0] },
							{ type: "jump", blocks: [2] },
							{ type: "tryEnd" },
						],
					},
					{ instructions: [{ type: "catch", registers: [0] }, left, right] },
					{
						instructions: [
							{ type: "tryBegin", blocks: [1, 2] },
							{ type: "return", registers: [-1] },
							{ type: "tryEnd" },
						],
					},
					{
						instructions: [
							{ type: "tryBegin", blocks: [1, 3] },
							{ type: "return", registers: [-1] },
							{ type: "tryEnd" },
						],
					},
				],
			}),
		).toEqual(new Set([left, right]));
	});

	it("preserves wide root mask storage through property-region fallbacks", () => {
		const parameters = Array.from({ length: 70 }, (_, index) => `value${index}`);
		const source = `function wide(${parameters.join(", ")}) {
			const pair = value0.a + value0.b;
			globalThis.collect();
			return pair + ${parameters
				.slice(1)
				.map((name) => `${name}.a`)
				.join(" + ")};
		} globalThis.wide = wide;`;
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "/wide-fallback.js"),
		);
		const native = image.native.functions[1]!;
		expect(native.storage?.rootRegisters.length).toBeGreaterThan(64);
		const output = emitCompiledFunction(native, 1, "", false)?.source;
		expect(output).toContain("MAL_ROOT_MASK_WIDE(");
		expect(output).toContain("mal_vm_property_try_load_static_number_pair(");
	});
	it("preserves certified region exits through native edge copies", () => {
		const source = `globalThis.sum = function sum(value, regexp) {
			let sum = 0;
			for (const match of value.matchAll(regexp)) {
				sum += Number(match[1]);
				if (sum > 10) break;
			}
			return sum;
		};`;
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "/native-region-exit.js"),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const fn = image.native.functions[1]!;
		const region = fn.specializations.find(
			(region) => region.kind === "regexp-iterator-projection",
		);
		if (region?.kind !== "regexp-iterator-projection")
			throw new Error("Missing RegExp iterator projection");
		const branch = fn.body.instructions[region.doneBranchIp]!;
		if (branch.opcode !== "JUMP_IF") throw new Error("Missing region exit branch");
		expect(branch.targetIp).not.toBe(region.exitIp);
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
		const invalid = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((native) =>
					native !== fn
						? native
						: {
								...fn,
								body: {
									...fn.body,
									instructions: fn.body.instructions.map((op) =>
										op !== branch ? op : { ...branch, targetIp: region.loads[0]!.ip },
									),
								},
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(invalid)).toThrow(
			/invalid RegExp iterator projection/,
		);
	});

	const scalarImage = (body: string, profile = false) =>
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.scalar = (left, right, one) => {
					const a = +left;
					const b = +right;
					const subtract = +one;
					${body}
				};`,
				"/native-expression.js",
			),
			{ profile },
		);
	const multiplicationIp = (image: ReturnType<typeof scalarImage>) =>
		image.native.functions[1]!.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);

	it("carries proven single-use scalar expressions through the artifact", () => {
		const image = scalarImage("return a * b - subtract;");
		const multiplication = multiplicationIp(image);
		expect(multiplication).toBeGreaterThanOrEqual(0);
		expect(image.native.functions[1]!.storage!.expressionIps).toContain(multiplication);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(
			image.native.functions[1]!.storage,
		);
	});

	it("folds scalar chains beside independently selected calls", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function observe(value) {
					for (let index = 0; index < 2; index++) globalThis.observe(value, index);
				}
				globalThis.scalar = (left, right, one) => {
					const a = +left;
					const b = +right;
					const subtract = +one;
					observe(a);
					return a * b - subtract;
				};`,
				"/native-expression-call.js",
			),
		);
		const native = image.native.functions.find((fn) =>
			fn.body.instructions.some((op) => op.opcode === "BINARY" && op.operator === "*"),
		)!;
		expect(native.instructions.some((plan) => plan?.kind === "call")).toBe(true);
		const product = native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(native.storage!.expressionIps).toContain(product);
		expect(() =>
			emitProgramImage(deserializeCompilerArtifact(serializeCompilerArtifact(image)), {
				compiled: true,
			}),
		).not.toThrow();
	});

	it("initializes scalar locals at a dominating definition across ordinary effects", () => {
		const image = scalarImage(
			"const product = a * b; globalThis.observe(); return product - subtract;",
			true,
		);
		const native = image.native.functions[1]!;
		const product = native.body.instructions[multiplicationIp(image)]!;
		if (product.opcode !== "BINARY") throw new Error("Missing scalar product");
		expect(native.storage!.expressionIps).toEqual([]);
		expect(native.storage!.definitionInitializedRegisters).toContain(product.dst);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(native.storage);
	});

	it("retains initialization when scalar uses cross control-flow boundaries", () => {
		const image = scalarImage(
			"const product = a * b; if (globalThis.condition) globalThis.observe(product); return product - subtract;",
		);
		const native = image.native.functions[1]!;
		const product = native.body.instructions[multiplicationIp(image)]!;
		if (product.opcode !== "BINARY") throw new Error("Missing scalar product");
		expect(native.storage!.definitionInitializedRegisters).not.toContain(product.dst);
		const invalid = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn !== native
						? fn
						: {
								...fn,
								storage: {
									...fn.storage!,
									definitionInitializedRegisters: [
										...fn.storage!.definitionInitializedRegisters,
										product.dst,
									].sort((left, right) => left - right),
								},
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(invalid)).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("plans numeric leaf expressions independently of boxed-body overlays", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function calculate(condition, left, right) {
					if (condition) return left * right - 1;
					return left / right + 1;
				}
				globalThis.calculate = calculate;
				for (let index = 0; index < 3; index++) {
					globalThis.result = calculate(index > 0, index + 3, 4);
				}`,
				"/native-leaf-expression.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const native = image.native.functions.find((fn) =>
			fn.directEntries.some((entry) => entry.storage?.numericLeaf !== undefined),
		)!;
		expect(native).toBeDefined();
		expect(
			native.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		const entry = native.directEntries.find(
			(entry) => entry.storage?.numericLeaf !== undefined,
		)!;
		const leaf = entry.storage!.numericLeaf!;
		expect(leaf.expressionIps.length).toBeGreaterThan(0);
		expect(native.storage!.rematerializedConstantIps.length).toBeGreaterThan(0);
		expect(leaf.rematerializedConstantIps.length).toBeGreaterThan(0);
		const targets = new Set(
			native.body.instructions.flatMap((op) =>
				op.opcode === "JUMP" || op.opcode === "JUMP_IF" ? [op.targetIp] : [],
			),
		);
		expect(leaf.expressionIps.some((ip) => targets.has(ip))).toBe(true);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[native.functionIndex]!.directEntries).toEqual(
			native.directEntries,
		);
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
		const invalid = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn !== native
						? fn
						: {
								...fn,
								storage: { ...fn.storage!, numericLeaf: leaf },
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(invalid)).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("rematerializes repeated scalar constants across calls and dominated branches", () => {
		const image = scalarImage(
			"const mask = 17; const offset = 1.25; globalThis.observe(mask, offset); if (globalThis.condition) return ((a & mask) + mask) * offset; return (a + mask) / offset;",
		);
		const native = image.native.functions[1]!;
		const constants = native.body.instructions.flatMap((op, ip) =>
			(op.opcode === "CREATE_NUMBER" && op.value === 17) ||
			(op.opcode === "CREATE_F64" && op.value === 1.25)
				? [ip]
				: [],
		);
		expect(constants).toHaveLength(2);
		expect(native.storage!.rematerializedConstantIps).toEqual(
			expect.arrayContaining(constants),
		);
		const integer = native.body.instructions[constants[0]!]!;
		if (!("dst" in integer)) throw new Error("Missing constant destination");
		expect(native.registerRepresentations[integer.dst]).toBe("int32");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(native.storage);
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
	});

	it("rejects constant rematerialization without immutable dominated SSA storage", () => {
		const template = scalarImage("return a + subtract;").native.functions[1]!.body;
		const cases: Array<{
			instructions: Array<BytecodeInstruction>;
			parameterCount?: number;
			argumentSnapshotCount?: number;
			storageValues?: Array<number>;
		}> = [
			{
				instructions: [
					{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
					{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
					{ opcode: "RETURN", value: 1 },
				],
			},
			{
				instructions: [
					{ opcode: "BINARY", dst: 2, left: 1, right: 1, operator: "+" },
					{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
					{ opcode: "RETURN", value: 2 },
				],
			},
			{
				instructions: [
					{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
					{ opcode: "CREATE_NUMBER", dst: 1, value: 9 },
					{ opcode: "RETURN", value: 1 },
				],
			},
			{
				instructions: [
					{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
					{ opcode: "RETURN", value: 0 },
				],
			},
			...[{ argumentSnapshotCount: 1 }, { storageValues: [0, -1, 2] }].map((options) => ({
				...options,
				instructions: [
					{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
					{ opcode: "RETURN", value: 1 },
				] satisfies Array<BytecodeInstruction>,
			})),
		];
		for (const options of cases) {
			const body = {
				...template,
				registerCount: 3,
				parameterCount: options.parameterCount ?? 1,
				argumentSnapshotCount: options.argumentSnapshotCount ?? 0,
				instructions: options.instructions,
			};
			const native = lowerNativeFunctionStorage({
				...createConservativeNativePlan([body]).functions[0]!,
				gc: { safepoints: [] },
				storageValues: options.storageValues ?? [0, 1, 2],
				registerRepresentations: ["number", "int32", "number"],
			});
			expect(native.storage!.rematerializedConstantIps).toEqual([]);
			const constant = body.instructions.findIndex((op) => op.opcode === "CREATE_NUMBER");
			expect(() =>
				validateNativeStorage({
					...native,
					storage: { ...native.storage!, rematerializedConstantIps: [constant] },
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});

	it("retains producers around effects, repeated uses, and profiling", () => {
		for (const body of [
			"const product = a * b; globalThis.observe(); return product - subtract;",
			"const product = a * b; return product + product;",
		]) {
			const image = scalarImage(body);
			expect(image.native.functions[1]!.storage!.expressionIps).not.toContain(
				multiplicationIp(image),
			);
		}
		const profiled = scalarImage("return a * b - subtract;", true);
		expect(profiled.native.functions[1]!.storage!.expressionIps).toEqual([]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(profiled));
		expect(restored.native.functions[1]!.storage!.expressionIps).toEqual([]);
		const constants =
			"const mask = 17; globalThis.observe(mask); return (a & mask) + mask;";
		expect(
			scalarImage(constants).native.functions[1]!.storage!.rematerializedConstantIps
				.length,
		).toBeGreaterThan(0);
		expect(
			scalarImage(constants, true).native.functions[1]!.storage!
				.rematerializedConstantIps,
		).toEqual([]);
	});

	it("rejects an expression choice that crosses an observable call", () => {
		const image = scalarImage(
			"const product = a * b; globalThis.observe(); return product - subtract;",
		);
		const native = image.native.functions[1]!;
		const malformed = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn !== native
						? fn
						: {
								...fn,
								storage: { ...fn.storage!, expressionIps: [multiplicationIp(image)] },
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("owns value identities and a body independently of VM register coloring", () => {
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(source, "/native-storage.js"),
			{},
			(_phase, run) => run(),
		);
		const colored = lowerCoreCompilationToExecutionProgram(core);
		const unique = lowerCoreCompilationToExecutionProgram(core, {
			reuseRegisters: false,
		});
		expect(colored.functions.map((fn) => fn.registerCount)).not.toEqual(
			unique.functions.map((fn) => fn.registerCount),
		);
		const native = lowerCoreCompilationToNativeProgram(core);
		for (const fn of native.functions) {
			const values = fn.storageValues.filter((value) => value >= 0);
			expect(new Set(values).size).toBe(values.length);
		}
		const first = lowerExecutionToProgramImage(colored, native);
		const second = lowerExecutionToProgramImage(unique, native);
		expect(first.native).toEqual(second.native);
		expect(
			first.native.functions.some(
				(fn, index) =>
					fn.body.registerCount > first.runtime.functions[index]!.registerCount,
			),
		).toBe(true);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(first));
		expect(restored.native.functions.map((fn) => fn.body.instructions)).toEqual(
			first.native.functions.map((fn) => fn.body.instructions),
		);
		expect(restored.native.functions.map((fn) => fn.storageValues)).toEqual(
			first.native.functions.map((fn) => fn.storageValues),
		);
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
	});
});
