import { describe, expect, it } from "vitest";
import {
	CORE_CALLEE_TARGETS_ANY_SCRIPT,
	CORE_CALLEE_TARGETS_BOTTOM,
	CORE_CALLEE_TARGETS_OPAQUE,
	CORE_CALLEE_TARGET_CAP,
	analyzeCoreCalleeTargets,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsClosedFunction,
	coreCalleeTargetsFunction,
	coreCalleeTargetsIsBottom,
	coreCalleeTargetsSingleFunction,
	joinCoreCalleeTargets,
} from "../src/compiler/core/core-ir-call-targets.ts";
import type { CoreCalleeTargets } from "../src/compiler/core/core-ir-call-targets.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreAttributeObject,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { lowerCoreProgramToTarget } from "../src/compiler/target/core-target-lowering.ts";

function coreProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 8,
	};
}

/** A one-block function whose body a caller supplies; index 0 by default. */
function leafFunction(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: value! });
	return builder.finish(entry);
}

/**
 * Module scope is what gives a top-level function declaration a compiler-owned
 * global slot; a script's declarations are reassignable global properties, which
 * this analysis deliberately never trusts.
 */
function optimizedCore(source: string, path: string): CoreProgram {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, path, parseModule(source));
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToVmDefinition(semantic, {
		// Inlining runs before annotation and would consume the call sites this
		// suite is about.
		optimizationAblations: new Set(["inlining"] as const),
		afterCoreOptimization(program) {
			optimized = program;
		},
	});
	return optimized!;
}

function callSites(fn: CoreFunction): ReadonlyArray<CoreInstruction> {
	return fn.blocks
		.flatMap(({ instructions }) => instructions)
		.filter(({ opcode }) => opcode === "call" || opcode === "construct");
}

function functionIndexOfName(program: CoreProgram, name: string): number {
	const found = program.functions.find(
		(fn) =>
			String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			) === name,
	);
	expect(found, `no Core function named ${name}`).toBeDefined();
	return found!.functionIndex;
}

interface AnnotatedTargets {
	readonly functions: ReadonlyArray<number>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
}

function calleeTargetsAttribute(
	instruction: CoreInstruction,
): AnnotatedTargets | undefined {
	const value = instruction.attributes.calleeTargets;
	if (value === undefined) return undefined;
	const record = value as CoreAttributeObject;
	return {
		functions: (record.functions ?? []) as ReadonlyArray<number>,
		anyScript: record.anyScript === true,
		opaque: record.opaque === true,
	};
}

describe("bounded callee-target lattice", () => {
	it("joins two singletons into a deterministic sorted pair", () => {
		const joined = joinCoreCalleeTargets(
			coreCalleeTargetsFunction(7),
			coreCalleeTargetsFunction(3),
		);
		expect(joined.functions).toEqual([3, 7]);
		expect(joined.anyScript).toBe(false);
		expect(joined.opaque).toBe(false);
		expect(coreCalleeTargetsSingleFunction(joined)).toBeUndefined();
		expect(coreCalleeTargetsClosedFunction(joined)).toBeUndefined();
	});

	it("is commutative and idempotent over the same candidates", () => {
		const left = joinCoreCalleeTargets(
			coreCalleeTargetsFunction(2),
			coreCalleeTargetsFunction(9),
		);
		const right = joinCoreCalleeTargets(
			coreCalleeTargetsFunction(9),
			coreCalleeTargetsFunction(2),
		);
		expect(left).toEqual(right);
		expect(joinCoreCalleeTargets(left, right)).toEqual(left);
	});

	it("treats bottom as the identity and reports it as uninitialized", () => {
		expect(coreCalleeTargetsIsBottom(CORE_CALLEE_TARGETS_BOTTOM)).toBe(true);
		const singleton = coreCalleeTargetsFunction(4);
		expect(joinCoreCalleeTargets(CORE_CALLEE_TARGETS_BOTTOM, singleton)).toEqual(
			singleton,
		);
		expect(joinCoreCalleeTargets(singleton, CORE_CALLEE_TARGETS_BOTTOM)).toEqual(
			singleton,
		);
	});

	it("keeps a known candidate when an unknown source joins in", () => {
		const speculative = joinCoreCalleeTargets(
			coreCalleeTargetsFunction(5),
			CORE_CALLEE_TARGETS_OPAQUE,
		);
		expect(speculative.functions).toEqual([5]);
		expect(speculative.opaque).toBe(true);
		expect(coreCalleeTargetsAreOpen(speculative)).toBe(true);
		// Usable for a guarded specialization, never as a closed proof.
		expect(coreCalleeTargetsSingleFunction(speculative)).toBe(5);
		expect(coreCalleeTargetsClosedFunction(speculative)).toBeUndefined();
	});

	it("widens finite overflow to any script and keeps the opacity bit", () => {
		let targets: CoreCalleeTargets = CORE_CALLEE_TARGETS_BOTTOM;
		for (let index = 0; index <= CORE_CALLEE_TARGET_CAP; index++) {
			targets = joinCoreCalleeTargets(targets, coreCalleeTargetsFunction(index));
			if (index < CORE_CALLEE_TARGET_CAP) {
				expect(targets.functions).toHaveLength(index + 1);
				expect(targets.anyScript).toBe(false);
			}
		}
		expect(targets.functions).toEqual([]);
		expect(targets.anyScript).toBe(true);
		expect(targets.opaque).toBe(false);
		expect(coreCalleeTargetsSingleFunction(targets)).toBeUndefined();

		const opened = joinCoreCalleeTargets(targets, CORE_CALLEE_TARGETS_OPAQUE);
		expect(opened.anyScript).toBe(true);
		expect(opened.opaque).toBe(true);
		// Widening is monotone: re-joining a candidate cannot narrow the result.
		expect(joinCoreCalleeTargets(opened, coreCalleeTargetsFunction(1))).toEqual(opened);
	});

	it("keeps overflow and opacity as independent losses", () => {
		expect(CORE_CALLEE_TARGETS_ANY_SCRIPT.opaque).toBe(false);
		expect(CORE_CALLEE_TARGETS_OPAQUE.anyScript).toBe(false);
		expect(coreCalleeTargetsAreOpen(CORE_CALLEE_TARGETS_ANY_SCRIPT)).toBe(true);
		expect(coreCalleeTargetsAreOpen(coreCalleeTargetsFunction(0))).toBe(false);
	});
});

describe("callee-target solver", () => {
	it("propagates a global slot store to its loads through a move", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		const [moved] = builder.appendInstruction(entry, "move", [created!]);
		builder.appendInstruction(entry, "storeGlobal", [moved!], {
			attributes: { index: 2 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 2 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(analysis.globalSlot(2)).toEqual(coreCalleeTargetsFunction(0));
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, loaded!))).toBe(0);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, moved!))).toBe(0);
	});

	it("propagates a captured closure slot across functions", () => {
		const writer = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const writerEntry = writer.createBlock();
		const [created] = writer.appendInstruction(writerEntry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		writer.appendInstruction(writerEntry, "storeCaptured", [created!], {
			attributes: { functionIndex: 1, index: 3 },
		});
		writer.setTerminator(writerEntry, { kind: "return", value: created! });

		const reader = new CoreFunctionBuilder(2, coreOpcodeRegistry);
		const readerEntry = reader.createBlock();
		const [loaded] = reader.appendInstruction(readerEntry, "loadCaptured", [], {
			attributes: { functionIndex: 1, index: 3 },
		});
		reader.setTerminator(readerEntry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([
				leafFunction(0),
				writer.finish(writerEntry),
				reader.finish(readerEntry),
			]),
		);
		expect(analysis.capturedSlot(1, 3)).toEqual(coreCalleeTargetsFunction(0));
		expect(coreCalleeTargetsClosedFunction(analysis.targets(2, loaded!))).toBe(0);
		// A slot nobody writes stays bottom rather than becoming open.
		expect(coreCalleeTargetsIsBottom(analysis.capturedSlot(1, 4))).toBe(true);
	});

	it("joins two ordinary block arguments into a two-target set", () => {
		const builder = new CoreFunctionBuilder(2, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{}]);
		const [first] = builder.appendInstruction(left, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		const [second] = builder.appendInstruction(right, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const merged = builder.block(join).parameters[0]!.value;
		builder.setTerminator(join, { kind: "return", value: merged });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), leafFunction(1), builder.finish(entry)]),
		);
		const targets = analysis.targets(2, merged);
		expect(targets.functions).toEqual([0, 1]);
		expect(coreCalleeTargetsAreOpen(targets)).toBe(false);
		expect(coreCalleeTargetsSingleFunction(targets)).toBeUndefined();
	});

	it("keeps the known candidate when one join edge is a caller-supplied argument", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const incoming = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const join = builder.createBlock([{}]);
		const [created] = builder.appendInstruction(left, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: incoming,
			consequent: { block: left, arguments: [] },
			alternate: { block: join, arguments: [incoming] },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [created!] },
		});
		const merged = builder.block(join).parameters[0]!.value;
		builder.setTerminator(join, { kind: "return", value: merged });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		const targets = analysis.targets(1, merged);
		expect(targets.functions).toEqual([0]);
		expect(targets.opaque).toBe(true);
		expect(coreCalleeTargetsSingleFunction(targets)).toBe(0);
		expect(coreCalleeTargetsClosedFunction(targets)).toBeUndefined();
	});

	it("widens a global slot past the cap instead of picking a subset", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const functions: Array<CoreFunction> = [];
		for (let index = 1; index <= CORE_CALLEE_TARGET_CAP + 1; index++) {
			functions.push(leafFunction(index));
			const [created] = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: index },
			});
			builder.appendInstruction(entry, "storeGlobal", [created!], {
				attributes: { index: 1 },
			});
		}
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([builder.finish(entry), ...functions]),
		);
		const targets = analysis.targets(0, loaded!);
		expect(targets.functions).toEqual([]);
		expect(targets.anyScript).toBe(true);
		expect(targets.opaque).toBe(false);
	});

	it("ignores the uninitialized sentinel stored into a lexical global slot", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [sentinel] = builder.appendInstruction(entry, "createEmpty", []);
		const [aliased] = builder.appendInstruction(entry, "move", [sentinel!]);
		builder.appendInstruction(entry, "storeGlobal", [aliased!], {
			attributes: { index: 5 },
		});
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 5 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 5 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, loaded!))).toBe(0);
	});

	it("degrades only the slot an unresolvable value is written to", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 1 },
		});
		builder.appendInstruction(entry, "storeCaptured", [created!], {
			attributes: { functionIndex: 1, index: 0 },
		});
		// A property load is exactly the shape a direct-eval writeback has: a value
		// this analysis cannot name.
		const [unknown] = builder.appendInstruction(entry, "loadGlobalProperty", [], {
			attributes: { nameStringIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [unknown!], {
			attributes: { index: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: created! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		const degraded = analysis.globalSlot(1);
		expect(degraded.functions).toEqual([0]);
		expect(degraded.opaque).toBe(true);
		// The sibling captured slot, written by the same value, keeps its proof.
		expect(coreCalleeTargetsClosedFunction(analysis.capturedSlot(1, 0))).toBe(0);
	});

	it("opens a whole slot family when a write does not name its slot", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 1 },
		});
		builder.appendInstruction(entry, "storeCaptured", [created!], {
			attributes: { functionIndex: 1, index: 0 },
		});
		// No slot index: the write covers the global-slot family as a whole.
		builder.appendInstruction(entry, "storeGlobal", [created!], {});
		builder.setTerminator(entry, { kind: "return", value: created! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(analysis.globalSlot(1).opaque).toBe(true);
		expect(analysis.globalSlot(1).functions).toEqual([0]);
		// Degradation is per family, not per program.
		expect(coreCalleeTargetsClosedFunction(analysis.capturedSlot(1, 0))).toBe(0);
	});

	it("exempts per-iteration environment edits from opening captured slots", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeCaptured", [created!], {
			attributes: { functionIndex: -1, index: 0 },
		});
		builder.appendInstruction(entry, "envCopy", [], {
			attributes: { scopeId: -1, slotCount: 1 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadCaptured", [], {
			attributes: { functionIndex: -1, index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, loaded!))).toBe(0);
	});

	it("converges on a loop-carried value and on a self-referential slot", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [seed] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		const header = builder.createBlock([{}]);
		const latch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [seed!] },
		});
		const carried = builder.block(header).parameters[0]!.value;
		// The slot's only writer reads the slot back, so its dependency graph has a
		// cycle through both a block parameter and a captured cell.
		builder.appendInstruction(header, "storeCaptured", [carried], {
			attributes: { functionIndex: 1, index: 0 },
		});
		const [reloaded] = builder.appendInstruction(header, "loadCaptured", [], {
			attributes: { functionIndex: 1, index: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: latch, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(latch, {
			kind: "jump",
			edge: { block: header, arguments: [reloaded!] },
		});
		builder.setTerminator(exit, { kind: "return", value: carried });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, carried))).toBe(0);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, reloaded!))).toBe(0);
		expect(coreCalleeTargetsClosedFunction(analysis.capturedSlot(1, 0))).toBe(0);
	});

	it("bounds propagation work by the lattice height rather than by round count", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		let value: CoreValueId = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		})[0]!;
		for (let index = 0; index < 200; index++) {
			value = builder.appendInstruction(entry, "move", [value])[0]!;
		}
		builder.setTerminator(entry, { kind: "return", value });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, value))).toBe(0);
		// Each node rises at most once here; a re-scanning solver would revisit the
		// whole chain every round.
		expect(analysis.statistics.propagations).toBeLessThanOrEqual(
			analysis.statistics.nodes * (CORE_CALLEE_TARGET_CAP + 2),
		);
	});
});

describe("callee-target annotation", () => {
	it("keeps an exact direct target for a closed top-level function", () => {
		const program = optimizedCore(
			`function target(value) { return value + 1; }
			function caller(value) { return target(value); }
			caller(1);`,
			"call-targets-exact.mjs",
		);
		const targetIndex = functionIndexOfName(program, "target");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const sites = callSites(caller);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBe(targetIndex);
		expect(calleeTargetsAttribute(sites[0]!)).toEqual({
			functions: [targetIndex],
			anyScript: false,
			opaque: false,
		});
	});

	it("keeps a direct construct target and records its closed proof", () => {
		const program = optimizedCore(
			`function Shape(size) { this.size = size; }
			function make(size) { return new Shape(size); }
			make(2);`,
			"call-targets-construct.mjs",
		);
		const shapeIndex = functionIndexOfName(program, "Shape");
		const make = program.functions[functionIndexOfName(program, "make")]!;
		const sites = callSites(make).filter(({ opcode }) => opcode === "construct");
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBe(shapeIndex);
		expect(calleeTargetsAttribute(sites[0]!)?.opaque).toBe(false);
	});

	it("keeps Function.prototype.call flattening with its exact receiver target", () => {
		const program = optimizedCore(
			`function target(value) { return value + 1; }
			function caller(value) { return target.call(target, value); }
			caller(1);`,
			"call-targets-flatten.mjs",
		);
		const targetIndex = functionIndexOfName(program, "target");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const flattened = callSites(caller).filter(
			({ attributes }) => attributes.directFunctionCall === true,
		);
		expect(flattened).toHaveLength(1);
		expect(flattened[0]!.attributes.directCallTargetFunctionIndex).toBe(targetIndex);
	});

	it("speculates on a singleton whose slot a second writer can retarget", () => {
		const program = optimizedCore(
			`let handler = function first(value) { return value; };
			function retarget(other) { handler = other; }
			function run(value) { return handler(value); }
			retarget(run);
			run(1);`,
			"call-targets-speculative.mjs",
		);
		const firstIndex = functionIndexOfName(program, "first");
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const sites = callSites(run);
		expect(sites).toHaveLength(1);
		// The runtime re-checks the live callee, so the guarded direct target is
		// still lowered while the lattice records that the slot stays open.
		expect(sites[0]!.attributes.directFunctionIndex).toBe(firstIndex);
		expect(calleeTargetsAttribute(sites[0]!)).toEqual({
			functions: [firstIndex],
			anyScript: false,
			opaque: true,
		});
	});

	it("records a bounded two-target set without naming a direct target", () => {
		const program = optimizedCore(
			`function first(value) { return value + 1; }
			function second(value) { return value + 2; }
			function run(flag, value) { return (flag ? first : second)(value); }
			run(true, 1);`,
			"call-targets-two.mjs",
		);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const sites = callSites(run);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(sites[0]!)?.functions).toEqual(
			[
				functionIndexOfName(program, "first"),
				functionIndexOfName(program, "second"),
			].sort((left, right) => left - right),
		);
	});

	it("keeps the bounded target set out of the target instruction stream", () => {
		const source = `function target(value) { return value + 1; }
			function caller(value) { return target(value); }
			caller(1);`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"call-targets-boundary.mjs",
			parseModule(source),
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			optimizationAblations: new Set(["inlining"] as const),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		const annotated = optimized!.functions.flatMap((fn) =>
			callSites(fn).filter(
				(instruction) => calleeTargetsAttribute(instruction) !== undefined,
			),
		);
		expect(annotated.length).toBeGreaterThan(0);

		const lowered = lowerCoreProgramToTarget(optimized!);
		const targetInstructions = lowered.functions.flatMap((fn) =>
			fn.blocks.flatMap(({ instructions }) => instructions),
		);
		expect(
			targetInstructions.filter((instruction) => "calleeTargets" in instruction),
		).toHaveLength(0);
		expect(
			targetInstructions.filter(
				(instruction) =>
					instruction.type === "call" && instruction.directFunctionIndex !== undefined,
			).length,
		).toBeGreaterThan(0);
	});
});
