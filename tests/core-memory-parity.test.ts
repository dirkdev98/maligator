import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function optimize(program: CoreProgram): CoreProgram {
	return optimizeCore({ program, context: programAnalysisContext() }).compilation.program;
}

function operationCount(fn: CoreFunctionStore, opcode: string): number {
	return coreOperations(fn).filter((instruction) => instruction.opcode === opcode).length;
}

function compileFunction(source: string, name = "read"): CoreFunctionStore {
	let program: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "core-memory-parity.js"),
		{
			afterCoreOptimization(optimized) {
				program = optimized;
			},
		},
	);
	return coreFunctionNamed(program!, name)!;
}

function compileFunctionAndPlan(
	source: string,
	name = "read",
): { readonly fn: CoreFunctionStore; readonly plan: CoreOptimizationPlan } {
	let program: CoreProgram | undefined;
	let plan: CoreOptimizationPlan | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "core-memory-parity.js"),
		{
			afterCoreOptimization(optimized, _context, _report, optimizedPlan) {
				program = optimized;
				plan = optimizedPlan;
			},
		},
	);
	return { fn: coreFunctionNamed(program!, name)!, plan: plan! };
}

describe("Core memory and escape parity", () => {
	it("keeps exact global slots independent", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [kept, other] = builder.blockParameters(entry).map(({ value }) => value);
		builder.appendInstruction(entry, "storeGlobal", [kept!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "storeCaptured", [other!], {
			attributes: { functionIndex: 0, index: 3 },
		});
		builder.appendInstruction(entry, "storeGlobal", [other!], {
			attributes: { index: 1 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "loadGlobal")).toBe(0);
		expect(
			[...fn.blockIds()].map((block) => fn.terminatorPayload(fn.blockTerminator(block))),
		).toContainEqual({ kind: "return", value: fn.parameters[0] });
	});

	it("forwards an exact captured store until an environment edit", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (edited: boolean) => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const stored = builder.blockParameters(entry)[0]!.value;
			builder.appendInstruction(entry, "storeCaptured", [stored], {
				attributes: { functionIndex: 0, index: 2 },
			});
			if (edited) {
				builder.appendInstruction(entry, "envCopy", [], {
					attributes: { scopeId: -1, slotCount: 1 },
				});
			}
			const [loaded] = builder.appendInstruction(entry, "loadCaptured", [], {
				attributes: { functionIndex: 0, index: 2 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry).function;
		};
		const forwardable = build(false);
		const invalidated = build(true);

		const optimized = optimize(program);
		expect(operationCount(optimized.function(forwardable), "loadCaptured")).toBe(0);
		expect(operationCount(optimized.function(invalidated), "loadCaptured")).toBe(1);
		expect(
			optimized
				.function(forwardable)
				.terminatorPayload(optimized.function(forwardable).blockTerminator(0 as never)),
		).toEqual({ kind: "return", value: optimized.function(forwardable).parameters[0] });
	});

	it("spends family precision only on exactly read slots", () => {
		const slotCount = 300;
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: slotCount + 1,
		});
		const buildWriteHeavy = () => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const stored = builder.blockParameters(entry)[0]!.value;
			for (let slot = 0; slot <= slotCount; slot++) {
				builder.appendInstruction(entry, "storeGlobal", [stored], {
					attributes: { index: slot },
				});
			}
			const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry).function;
		};
		const buildReadHeavy = () => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			let carried = builder.blockParameters(entry)[0]!.value;
			for (let slot = 0; slot < slotCount; slot++) {
				builder.appendInstruction(entry, "storeGlobal", [carried], {
					attributes: { index: slot },
				});
				const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
					attributes: { index: slot },
				});
				carried = loaded!;
			}
			builder.setTerminator(entry, { kind: "return", value: carried });
			return builder.finish(entry).function;
		};
		const writeHeavy = buildWriteHeavy();
		const readHeavy = buildReadHeavy();
		const optimized = optimize(program);

		expect(operationCount(optimized.function(writeHeavy), "loadGlobal")).toBe(0);
		expect(operationCount(optimized.function(readHeavy), "loadGlobal")).toBe(slotCount);
	});

	it("stops slot forwarding at calls and suspension", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const build = (barrier: "none" | "call" | "suspend") => {
			const builder = new CoreFunctionBuilder(program, {
				parameterCount: 1,
				isGenerator: barrier === "suspend",
			});
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const stored = builder.blockParameters(entry)[0]!.value;
			if (barrier === "suspend") builder.appendInstruction(entry, "generatorStart", []);
			builder.appendInstruction(entry, "storeGlobal", [stored], {
				attributes: { index: 0 },
			});
			if (barrier === "call") {
				const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
					attributes: { intrinsic: "Object" },
				});
				builder.appendInstruction(entry, "call", [callee!, stored]);
			}
			if (barrier === "suspend") {
				builder.appendInstruction(entry, "yield", [stored], { outputCount: 2 });
			}
			const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry).function;
		};
		const direct = build("none");
		const called = build("call");
		const suspended = build("suspend");
		const optimized = optimize(program);

		expect(operationCount(optimized.function(direct), "loadGlobal")).toBe(0);
		expect(operationCount(optimized.function(called), "loadGlobal")).toBe(1);
		expect(operationCount(optimized.function(suspended), "loadGlobal")).toBe(1);
	});

	it("keeps exact clock reads distinct", () => {
		let program: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function read(extra) {
					return Date.now(extra()) + Date.now(extra());
				}`,
				"core-memory-clock.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(optimized) {
					program = optimized;
				},
			},
		);
		const fn = coreFunctionNamed(program!, "read")!;
		expect(
			coreOperations(fn).filter(
				({ opcode, attributes }) =>
					opcode === "callBuiltin" && attributes.operation === "Date.now",
			),
		).toHaveLength(2);
	});

	it("keeps loop memory versions distinct around a conditional store", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [storeCondition, repeatCondition] = builder
			.blockParameters(entry)
			.map(({ value }) => value);
		const header = builder.createBlock();
		const store = builder.createBlock();
		const skip = builder.createBlock();
		const join = builder.createBlock();
		const exit = builder.createBlock();
		const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [before] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(header, "storeLocal", [before!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: storeCondition!,
			consequent: { block: store, arguments: [] },
			alternate: { block: skip, arguments: [] },
		});
		builder.appendInstruction(store, "storeGlobal", [replacement!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(store, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(skip, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [after] = builder.appendInstruction(join, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(join, {
			kind: "branch",
			condition: repeatCondition!,
			consequent: { block: header, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: after! });
		const finished = builder.finish(entry);

		expect(
			operationCount(optimize(program).function(finished.function), "loadGlobal"),
		).toBe(2);
	});

	it("does not forward global memory through an irreducible cycle", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const exit = builder.createBlock();
		const [value, condition] = builder.blockParameters(entry).map(({ value }) => value);
		builder.appendInstruction(entry, "storeGlobal", [value!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [fromLeft] = builder.appendInstruction(left, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(left, "storeGlobal", [fromLeft!], {
			attributes: { index: 1 },
		});
		builder.setTerminator(left, {
			kind: "branch",
			condition: condition!,
			consequent: { block: right, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [fromRight] = builder.appendInstruction(right, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(right, "storeGlobal", [fromRight!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(right, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: value! });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "loadGlobal")).toBe(2);
	});

	it("keeps a contained own slot across a call and reloads it after a store", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x66]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [parameter], {
			attributes: { keyStringIndices: [0] },
		});
		const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Object" },
		});
		builder.appendInstruction(entry, "call", [callee!, parameter]);
		const [afterCall] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 0 } },
		);
		builder.appendInstruction(entry, "storePropertyStatic", [object!, afterCall!], {
			attributes: { stringIndex: 0 },
		});
		const [afterStore] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 0 } },
		);
		builder.setTerminator(entry, { kind: "return", value: afterStore! });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "call")).toBe(1);
		expect(operationCount(fn, "loadPropertyStatic")).toBe(0);
		expect(operationCount(fn, "storePropertyStatic")).toBe(0);
		expect(
			[...fn.blockIds()].map((block) => fn.terminatorPayload(fn.blockTerminator(block))),
		).toContainEqual({ kind: "return", value: fn.parameters[0] });
	});

	it("converges deep branch-join scalar replacement without a round limit", () => {
		const joinCount = 24;
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: joinCount,
			stringConstants: [[0x66]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const condition = builder.blockParameters(entry)[0]!.value;
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		let current = entry;
		let returned = condition;
		for (let index = 0; index < joinCount; index++) {
			const [object] = builder.appendInstruction(current, "createObjectShaped", [zero!], {
				attributes: { keyStringIndices: [0] },
			});
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			builder.setTerminator(current, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.appendInstruction(left, "storePropertyStatic", [object!, one!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			builder.appendInstruction(right, "storePropertyStatic", [object!, zero!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 0 },
			});
			builder.appendInstruction(join, "storeGlobal", [loaded!], {
				attributes: { index },
			});
			current = join;
			returned = loaded!;
		}
		builder.setTerminator(current, { kind: "return", value: returned });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "loadPropertyStatic")).toBe(0);
		expect(operationCount(fn, "storePropertyStatic")).toBe(0);
	});

	it("prunes a handler after scalar replacement removes the last throwing access", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x66]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([{ role: "exception", representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [parameter], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		builder.setTerminator(handler, {
			kind: "throw",
			value: builder.blockParameters(handler)[0]!.value,
		});
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect([...fn.blockIds()]).toHaveLength(1);
		expect(fn.blockHandler([...fn.blockIds()][0]!)).toBeUndefined();
		expect(operationCount(fn, "loadPropertyStatic")).toBe(0);
	});

	it("tracks exact slot versions through multiple joins and backedges", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const buildBackedges = (write: boolean) => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const entry = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const [arm, repeat] = builder.blockParameters(entry).map(({ value }) => value);
			const header = builder.createBlock();
			const left = builder.createBlock();
			const right = builder.createBlock();
			const exit = builder.createBlock();
			const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
			const [before] = builder.appendInstruction(header, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(header, "storeLocal", [before!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(header, {
				kind: "branch",
				condition: arm!,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			if (write) {
				builder.appendInstruction(left, "storeGlobal", [replacement!], {
					attributes: { index: 0 },
				});
			}
			for (const block of [left, right]) {
				builder.setTerminator(block, {
					kind: "branch",
					condition: repeat!,
					consequent: { block: header, arguments: [] },
					alternate: { block: exit, arguments: [] },
				});
			}
			const [after] = builder.appendInstruction(exit, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(exit, { kind: "return", value: after! });
			return builder.finish(entry).function;
		};
		const buildJoins = (write: boolean) => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const condition = builder.blockParameters(entry)[0]!.value;
			const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(entry, "storeLocal", [before!], {
				attributes: { index: 0 },
			});
			let current = entry;
			for (let diamond = 0; diamond < 3; diamond++) {
				const left = builder.createBlock();
				const right = builder.createBlock();
				const join = builder.createBlock();
				builder.setTerminator(current, {
					kind: "branch",
					condition,
					consequent: { block: left, arguments: [] },
					alternate: { block: right, arguments: [] },
				});
				if (write && diamond === 1) {
					builder.appendInstruction(left, "storeGlobal", [replacement!], {
						attributes: { index: 0 },
					});
				}
				builder.setTerminator(left, {
					kind: "jump",
					edge: { block: join, arguments: [] },
				});
				builder.setTerminator(right, {
					kind: "jump",
					edge: { block: join, arguments: [] },
				});
				current = join;
			}
			const [after] = builder.appendInstruction(current, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(current, { kind: "return", value: after! });
			return builder.finish(entry).function;
		};
		const stableBackedges = buildBackedges(false);
		const writtenBackedges = buildBackedges(true);
		const stableJoins = buildJoins(false);
		const writtenJoins = buildJoins(true);
		const optimized = optimize(program);

		expect(operationCount(optimized.function(stableBackedges), "loadGlobal")).toBe(1);
		expect(operationCount(optimized.function(writtenBackedges), "loadGlobal")).toBe(2);
		expect(operationCount(optimized.function(stableJoins), "loadGlobal")).toBe(1);
		expect(operationCount(optimized.function(writtenJoins), "loadGlobal")).toBe(2);
	});

	it("does not forward a global slot into an exception handler", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const handler = builder.createBlock([{ role: "exception", representation: "boxed" }]);
		const [stored, callee] = builder.blockParameters(entry).map(({ value }) => value);
		builder.appendInstruction(entry, "storeGlobal", [stored!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "call", [callee!, stored!]);
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value: stored! });
		const [rescued] = builder.appendInstruction(handler, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(handler, { kind: "return", value: rescued! });
		const finished = builder.finish(entry);

		expect(
			operationCount(optimize(program).function(finished.function), "loadGlobal"),
		).toBe(1);
	});

	it("keeps an overwritten private store visible to an exception handler", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x76, 0x61, 0x6c, 0x75, 0x65]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [first, second] = builder.blockParameters(entry).map(({ value }) => value);
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [zero!], {
			attributes: { keyStringIndices: [0] },
		});
		const body = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception", representation: "boxed" }]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [] },
		});
		builder.appendInstruction(body, "storePropertyStatic", [object!, first!], {
			attributes: { stringIndex: 0 },
		});
		builder.appendInstruction(body, "requireCoercible", [second!]);
		builder.appendInstruction(body, "storePropertyStatic", [object!, second!], {
			attributes: { stringIndex: 0 },
		});
		builder.setHandler(body, handler);
		builder.setTerminator(body, { kind: "return", value: zero! });
		const [rescued] = builder.appendInstruction(
			handler,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 0 } },
		);
		builder.setTerminator(handler, { kind: "return", value: rescued! });
		const finished = builder.finish(entry);

		expect(
			operationCount(
				optimize(program).function(finished.function),
				"storePropertyStatic",
			),
		).toBe(2);
	});

	it("forwards a fresh own-slot load before a later escape", () => {
		const fn = compileFunction(`function read(value) {
			const object = { value };
			const loaded = object.value;
			globalThis.saved = object;
			return loaded;
		}`);
		expect(operationCount(fn, "loadPropertyStatic")).toBe(0);
		expect(operationCount(fn, "createObjectShaped")).toBe(1);
		expect(operationCount(fn, "storePropertyStatic")).toBe(1);
	});

	it("keeps inherited and escaped property accesses on guarded generic paths", () => {
		const inherited = compileFunction(`function read(value) {
			const object = { value };
			return object.missing + object.missing;
		}`);
		expect(operationCount(inherited, "loadPropertyStatic")).toBe(2);

		const escaped = compileFunction(`function read(value, touch) {
			const object = { value };
			touch(object);
			return object.value + object.value;
		}`);
		expect(operationCount(escaped, "createObjectShaped")).toBe(1);
		expect(
			operationCount(escaped, "loadPropertyStatic") +
				operationCount(escaped, "loadPropertyStaticShapeCase"),
		).toBe(2);
	});

	it("forwards present array elements across numeric and string aliases", () => {
		const fn = compileFunction(`function read(seed) {
			const values = [seed];
			const before = values[0];
			values["0"] = seed + 1;
			return before + values[0] + values.length + values.length;
		}`);
		const loads = coreOperations(fn).filter(
			({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
		);
		expect(loads).toHaveLength(1);
	});

	it("retains repeated hole and deleted-element reads that can reach inherited accessors", () => {
		const hole = compileFunction(`function read(seed) {
			const values = [seed, ,];
			return values[1] + values[1];
		}`);
		const deleted = compileFunction(`function read(seed) {
			const values = [seed];
			delete values[0];
			return values[0] + values[0];
		}`);
		for (const fn of [hole, deleted]) {
			expect(
				coreOperations(fn).filter(
					({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
				),
			).toHaveLength(2);
		}
	});

	it("removes unobservable primitive stores to a private array element", () => {
		const fn = compileFunction(
			`function write(seed) {
				const values = [seed > 0];
				values[0] = seed + 1;
				values["0"] = seed + 2;
				return seed;
			}`,
			"write",
		);
		expect(
			coreOperations(fn).filter(({ opcode }) =>
				["defineProperty", "storeProperty", "storePropertyStatic"].includes(opcode),
			),
		).toHaveLength(0);
	});

	it("scalarizes must-alias private slots while rooting their boxed field", () => {
		const fn = compileFunction(`function read(value, observe) {
			const object = { value };
			const alias = object;
			observe();
			alias.value = 0;
			return 1;
		}`);
		expect(operationCount(fn, "createObjectShaped")).toBe(0);
		expect(operationCount(fn, "storePropertyStatic")).toBe(0);
		expect(operationCount(fn, "rootUse")).toBeGreaterThan(0);
	});

	it("scalarizes a private object through a must-alias block parameter", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x76, 0x61, 0x6c, 0x75, 0x65]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [held, callee] = builder.blockParameters(entry).map(({ value }) => value);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [held!], {
			attributes: { keyStringIndices: [0] },
		});
		const body = builder.createBlock([{ representation: "boxed" }]);
		const alias = builder.blockParameters(body)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [object!] },
		});
		const [receiver] = builder.appendInstruction(body, "createUndefined", []);
		builder.appendInstruction(body, "call", [callee!, receiver!]);
		const [zero] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.appendInstruction(body, "storePropertyStatic", [alias, zero!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(body, { kind: "return", value: zero! });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "createObjectShaped")).toBe(0);
		expect(operationCount(fn, "storePropertyStatic")).toBe(0);
		expect(operationCount(fn, "rootUse")).toBeGreaterThan(0);
	});

	it("keeps a branch-joined object materialized after one arm publishes it", () => {
		const fn = compileFunction(`function read(value, publish) {
			const object = { value };
			const alias = object;
			if (publish) globalThis.saved = alias;
			else alias.value = 0;
			return object.value;
		}`);
		expect(operationCount(fn, "createObjectShaped")).toBe(1);
		expect(
			operationCount(fn, "loadPropertyStatic") +
				operationCount(fn, "loadPropertyStaticShapeCase"),
		).toBe(1);
	});

	it("retains an aggregate that may keep a WeakRef target alive", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x76, 0x61, 0x6c, 0x75, 0x65]],
		});
		const build = (occupant: "parameter" | "number") => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const held = builder.blockParameters(entry)[0]!.value;
			const [initial] =
				occupant === "parameter"
					? [held]
					: builder.appendInstruction(entry, "createNumber", [], {
							attributes: { value: 0 },
						});
			const [object] = builder.appendInstruction(
				entry,
				"createObjectShaped",
				[initial!],
				{ attributes: { keyStringIndices: [0] } },
			);
			const [stored] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			builder.appendInstruction(entry, "storePropertyStatic", [object!, stored!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: held });
			return builder.finish(entry).function;
		};
		const weak = build("parameter");
		const primitive = build("number");
		const optimized = optimize(program);

		expect(operationCount(optimized.function(weak), "createObjectShaped")).toBe(1);
		expect(operationCount(optimized.function(weak), "storePropertyStatic")).toBe(1);
		expect(operationCount(optimized.function(primitive), "createObjectShaped")).toBe(0);
		expect(operationCount(optimized.function(primitive), "storePropertyStatic")).toBe(0);
	});

	it("retains a private array whose overwritten element may hold a WeakRef target", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x30]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const held = builder.blockParameters(entry)[0]!.value;
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 1 },
		});
		const [key] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.appendInstruction(entry, "defineProperty", [array!, key!, held], {
			attributes: { enumerable: true },
		});
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.appendInstruction(entry, "storePropertyStatic", [array!, stored!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: held });
		const finished = builder.finish(entry);

		const fn = optimize(program).function(finished.function);
		expect(operationCount(fn, "createArray")).toBe(1);
		expect(operationCount(fn, "defineProperty")).toBe(1);
		expect(operationCount(fn, "storePropertyStatic")).toBe(1);
	});

	it("folds exact allocation observations without conflating distinct identities", () => {
		const fn = compileFunction(`function read(value) {
			const object = { value };
			const alias = object;
			const other = { value };
			return typeof object === "object" && object === alias && object !== other;
		}`);
		const operations = coreOperations(fn);
		const createdObject = (value: CoreValueId): boolean => {
			const definition = fn.valueDefinition(value);
			return (
				definition.kind === "instruction" &&
				fn.instructionOpcodeName(definition.instruction) === "createObjectShaped"
			);
		};
		expect(
			operations.some(
				({ opcode, attributes }) =>
					opcode === "unary" && attributes.operator === "typeof",
			),
		).toBe(false);
		expect(
			operations.some(
				({ opcode, inputs, attributes }) =>
					opcode === "binary" &&
					(attributes.operator === "===" || attributes.operator === "!==") &&
					inputs.some(createdObject),
			),
		).toBe(false);
	});

	it("folds exact observations while retaining an escaping identity", () => {
		const fn = compileFunction(`function read(value, escape) {
			const object = { value };
			const alias = object;
			if (escape) return alias;
			return typeof object === "object" && object === alias ? object.value : -1;
		}`);
		const operations = coreOperations(fn);
		expect(operationCount(fn, "createObjectShaped")).toBe(1);
		expect(
			operations.some(
				({ opcode, attributes }) =>
					opcode === "unary" && attributes.operator === "typeof",
			),
		).toBe(false);
		expect(
			operations.some(
				({ opcode, attributes, inputs }) =>
					opcode === "binary" &&
					attributes.operator === "===" &&
					inputs.some((value) => {
						const definition = fn.valueDefinition(value);
						return (
							definition.kind === "instruction" &&
							fn.instructionOpcodeName(definition.instruction) === "createObjectShaped"
						);
					}),
			),
		).toBe(false);
	});

	it("scalarizes source-level closed cells across boolean, integer, and mixed joins", () => {
		for (const source of [
			`function read(flag, count) {
				const object = { value: true };
				for (let index = 0; index < count; index++) {
					if (flag) object.value = true;
					else object.value = false;
				}
				return object.value;
			}`,
			`function read(flag, count) {
				const object = { value: true };
				for (let index = 0; index < count; index++) {
					if (flag) object.value = false;
					else object.value = 1;
				}
				return object.value;
			}`,
			`function read(flag) {
				const object = { value: 1 };
				const alias = object;
				if (flag) alias.value = 9;
				return object.value;
			}`,
		]) {
			const { fn, plan } = compileFunctionAndPlan(source);
			expect(operationCount(fn, "loadPropertyStatic")).toBe(0);
			expect(operationCount(fn, "storePropertyStatic")).toBe(0);
			expect(operationCount(fn, "createObjectShaped")).toBe(0);
			expect(
				plan.specializations.some(
					(specialization) =>
						specialization.function === fn.id &&
						specialization.kind === "stack-object-plan",
				),
			).toBe(false);
		}
	});

	it("plans return materialization for an escaping source-level closed cell", () => {
		const { fn, plan } = compileFunctionAndPlan(`function read(flag) {
			const object = { value: true };
			if (flag) object.value = false;
			return object;
		}`);
		const specialization = plan.specializations.find(
			(candidate) =>
				candidate.function === fn.id && candidate.kind === "stack-object-plan",
		);
		expect(specialization).toBeDefined();
		if (specialization?.kind !== "stack-object-plan") {
			throw new Error("Expected stack-object specialization");
		}
		expect(specialization.stackObject).toMatchObject({
			mode: "activation-local",
			slotCount: 1,
			materializations: [expect.objectContaining({ kind: "return" })],
		});
	});
});
