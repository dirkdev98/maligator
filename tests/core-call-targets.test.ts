import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
import { coreMemoryAccesses } from "../src/compiler/core/core-ir-memory.ts";
import {
	CORE_OPCODES,
	coreOpcodeRegistry,
} from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreAttributeObject,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { constructSemanticProgramCore } from "../src/compiler/core/semantic-lowering.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
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
function optimizedCore(source: string, path: string, profile = false): CoreProgram {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, path, parseModule(source));
	const conservative = conservativeCompilerProgramFacts();
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToVmDefinition(semantic, {
		profile,
		facts: { ...conservative, world: { ...conservative.world, realms: false } },
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

/**
 * Every instruction the registry declares as entering a callable, which is what
 * the solver keys its call-result dependencies on.
 */
function callLikeSites(fn: CoreFunction): ReadonlyArray<CoreInstruction> {
	return fn.blocks
		.flatMap(({ instructions }) => instructions)
		.filter(({ opcode }) => coreOpcodeRegistry.get(opcode)?.callTransfer !== undefined);
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
		const builder = new CoreFunctionBuilder(2, coreOpcodeRegistry, {
			parameterCount: 1,
		});
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
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
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
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
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

	it("keeps a named cache-slot writer from opening the whole global family", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 0 },
		});
		// The runtime, not this graph, stores the cached strings object, so the cache
		// slot itself is opaque while every other global slot keeps its proof.
		builder.appendInstruction(entry, "createTemplateObject", [], {
			attributes: { cacheSlot: 1, cookedIndices: [0], rawIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreCalleeTargets(
			coreProgram([leafFunction(0), builder.finish(entry)]),
		);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, loaded!))).toBe(0);
		expect(analysis.globalSlot(1)).toEqual(CORE_CALLEE_TARGETS_OPAQUE);
	});

	it("declares the memory a template cache and a namespace name", () => {
		const template = coreOpcodeRegistry.require("createTemplateObject");
		expect(template.effects.reads).toContain("global-slot");
		expect(template.effects.writes).toContain("global-slot");
		expect(template.accesses).toEqual([
			{ family: "global-slot", mode: "read", attributes: ["cacheSlot"] },
			{ family: "global-slot", mode: "write", attributes: ["cacheSlot"] },
		]);
		const namespace = coreOpcodeRegistry.require("createModuleNamespace");
		// The export cells come from one list-valued attribute, so the read stays at
		// whole-family scope rather than claiming a cell it cannot decode.
		expect(namespace.effects.reads).toContain("global-slot");
		expect(namespace.accesses).toEqual([{ family: "global-slot", mode: "read" }]);
	});

	it("resolves a template cache to its cell and a namespace to its family", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "createTemplateObject", [], {
			attributes: { cacheSlot: 4, cookedIndices: [0], rawIndices: [0] },
		});
		const [namespace] = builder.appendInstruction(entry, "createModuleNamespace", [], {
			attributes: { exports: [{ nameStringIndex: 0, slot: 5 }] },
		});
		builder.setTerminator(entry, { kind: "return", value: namespace! });
		const instructions = builder.finish(entry).blocks[0]!.instructions;
		const locations = (instruction: CoreInstruction) =>
			coreMemoryAccesses(instruction).map(({ mode, location }) => ({
				mode,
				location,
			}));
		expect(locations(instructions[0]!)).toEqual([
			{ mode: "read", location: { kind: "global-slot", slot: 4 } },
			{ mode: "write", location: { kind: "global-slot", slot: 4 } },
		]);
		expect(locations(instructions[1]!)).toEqual([
			{ mode: "read", location: { kind: "family", family: "global-slot" } },
		]);
	});

	it("resolves a static module-namespace export through its live global cell", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 5 },
		});
		const [namespace] = builder.appendInstruction(entry, "createModuleNamespace", [], {
			attributes: { exports: [{ nameStringIndex: 1, slot: 5 }] },
		});
		builder.appendInstruction(entry, "storeGlobal", [namespace!], {
			attributes: { index: 4 },
		});
		const [loadedNamespace] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 4 },
		});
		const [loaded] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[loadedNamespace!],
			{
				attributes: { stringIndex: 1 },
			},
		);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const shell = coreProgram([leafFunction(0), builder.finish(entry)]);
		const program = {
			...shell,
			stringConstants: [[], [..."run"].map((character) => character.codePointAt(0)!)],
		};

		const analysis = analyzeCoreCalleeTargets(program);
		expect(coreCalleeTargetsClosedFunction(analysis.targets(1, loaded!))).toBe(0);
	});

	it("observes every function assigned to a live module-namespace export", () => {
		const builder = new CoreFunctionBuilder(2, coreOpcodeRegistry);
		const entry = builder.createBlock();
		for (const functionIndex of [0, 1]) {
			const [created] = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex },
			});
			builder.appendInstruction(entry, "storeGlobal", [created!], {
				attributes: { index: 5 },
			});
		}
		const [namespace] = builder.appendInstruction(entry, "createModuleNamespace", [], {
			attributes: { exports: [{ nameStringIndex: 1, slot: 5 }] },
		});
		const [loaded] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[namespace!],
			{ attributes: { stringIndex: 1 } },
		);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const shell = coreProgram([leafFunction(0), leafFunction(1), builder.finish(entry)]);
		const program = {
			...shell,
			stringConstants: [[], [..."run"].map((character) => character.codePointAt(0)!)],
		};

		expect(analyzeCoreCalleeTargets(program).targets(2, loaded!)).toEqual({
			functions: [0, 1],
			anyScript: false,
			opaque: false,
		});
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
	it("retracts a stale direct target when the final graph is open", () => {
		const builder = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const callee = builder.block(entry).parameters[0]!.value;
		const [thisValue] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee, thisValue!], {
			attributes: {
				directFunctionIndex: 0,
				calleeTargets: { functions: [0], anyScript: false, opaque: false },
			},
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const optimized = executeCoreOptimizations(
			coreProgram([leafFunction(0), builder.finish(entry)]),
			{ ablations: new Set(["inlining"] as const) },
		).program;
		const [call] = callSites(optimized.functions[1]!);
		expect(call?.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(call!)).toBeUndefined();
	});

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

	it("keeps guarded direct construct dispatch for an open singleton", () => {
		const program = optimizedCore(
			`let Shape = function Shape(size) { this.size = size; };
			function install(other) { Shape = other; }
			globalThis.install = install;
			function make(size) { return new Shape(size); }
			make(2);`,
			"call-targets-construct-open.mjs",
		);
		const shapeIndex = functionIndexOfName(program, "Shape");
		const make = program.functions[functionIndexOfName(program, "make")]!;
		const sites = callSites(make).filter(({ opcode }) => opcode === "construct");
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBe(shapeIndex);
		expect(calleeTargetsAttribute(sites[0]!)).toEqual({
			functions: [shapeIndex],
			anyScript: false,
			opaque: true,
		});
	});

	it("keeps an open constructor method candidate without residual direct dispatch", () => {
		const program = optimizedCore(
			`class Service { handle(value) { return value + 1; } }
			function caller(value) { const service = new Service(); return service.handle(value); }
			caller(1);`,
			"call-targets-constructor-method.mjs",
		);
		const methodIndex = functionIndexOfName(program, "handle");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const site = callSites(caller).find(({ opcode }) => opcode === "call");
		expect(site).toBeDefined();
		expect(site!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)).toEqual({
			functions: [methodIndex],
			anyScript: false,
			opaque: true,
		});
	});

	it("does not guess a prototype method when a constructor returns an object", () => {
		const program = optimizedCore(
			`function alternate(value) { return value + 2; }
			class Service {
				constructor() { return { handle: alternate }; }
				handle(value) { return value + 1; }
			}
			function caller(value) { return new Service().handle(value); }
			caller(1);`,
			"call-targets-constructor-object-return.mjs",
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const site = callSites(caller).find(({ opcode }) => opcode === "call");
		expect(site).toBeDefined();
		expect(site!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)).toBeUndefined();
	});

	it.each([
		{
			name: "derived class",
			source: `class Base {}
				class Service extends Base { handle(value) { return value + 1; } }`,
		},
		{
			name: "accessor",
			source: `function handle(value) { return value + 1; }
				class Service { get callback() { return handle; } }`,
		},
		{
			name: "computed method",
			source: `class Service { ["handle"](value) { return value + 1; } }`,
		},
	])("leaves a $name constructor property read unresolved", ({ name, source }) => {
		const property = name === "accessor" ? "callback" : "handle";
		const program = optimizedCore(
			`${source}
			function caller(value) { return new Service().${property}(value); }
			caller(1);`,
			`call-targets-constructor-${name.replaceAll(" ", "-")}.mjs`,
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const site = callSites(caller).find(({ opcode }) => opcode === "call");
		expect(site).toBeDefined();
		expect(site!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)).toBeUndefined();
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

	it("flattens Function.prototype.call without speculating on an open receiver", () => {
		const program = optimizedCore(
			`let target = function target(value) { return value + 1; };
			function install(other) { target = other; }
			globalThis.install = install;
			function caller(value) {
				const current = target;
				return current.call(current, value);
			}
			caller(1);`,
			"call-targets-flatten-open.mjs",
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const flattened = callSites(caller).filter(
			({ attributes }) => attributes.directFunctionCall === true,
		);
		expect(flattened).toHaveLength(1);
		expect(flattened[0]!.attributes.directCallTargetFunctionIndex).toBeUndefined();
	});

	it("resolves a real ESM namespace import to its exporter", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-callee-namespace-"));
		try {
			const dependency = path.join(root, "dependency.mjs");
			const entry = path.join(root, "entry.mjs");
			writeFileSync(dependency, "export function run(value) { return value + 1; }\n");
			writeFileSync(
				entry,
				'import * as service from "./dependency.mjs";\n' +
					"export function caller(value) { return service.run(value); }\n" +
					"caller(1);\n",
			);
			const semantic = loadEntrypointAndRunSemanticAnalysis(entry);
			const conservative = conservativeCompilerProgramFacts();
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToVmDefinition(semantic, {
				facts: {
					...conservative,
					world: { ...conservative.world, realms: false },
				},
				optimizationAblations: new Set(["inlining"] as const),
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			const target = functionIndexOfName(optimized!, "run");
			const caller = optimized!.functions[functionIndexOfName(optimized!, "caller")]!;
			const [site] = callSites(caller);
			expect(site?.attributes.directFunctionIndex).toBe(target);
			expect(calleeTargetsAttribute(site!)).toEqual({
				functions: [target],
				anyScript: false,
				opaque: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a factory result reached through guarded Function.prototype.call", () => {
		const program = optimizedCore(
			`function inner(value) { return value + 1; }
			function factory() { return inner; }
			function caller(value) { return factory.call(factory)(value); }
			caller(1);`,
			"call-targets-flatten-result.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const sites = callSites(caller);
		const flattened = sites.find(
			({ attributes }) => attributes.directFunctionCall === true,
		);
		const returned = sites.find((site) =>
			calleeTargetsAttribute(site)?.functions.includes(innerIndex),
		);
		expect(flattened).toBeDefined();
		expect(returned).toBeDefined();
		expect(returned!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(returned!)).toEqual({
			functions: [innerIndex],
			anyScript: false,
			opaque: true,
		});
	});

	it("declines residual direct dispatch for an open singleton", () => {
		const program = optimizedCore(
			`let handler = function first(value) { return value; };
			function retarget(other) { handler = other; }
			function run(value) { return handler(value); }
			retarget(run);
			run(1);`,
			"call-targets-speculative.mjs",
			true,
		);
		const firstIndex = functionIndexOfName(program, "first");
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const sites = callSites(run);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(sites[0]!)).toEqual({
			functions: [firstIndex],
			anyScript: false,
			opaque: true,
		});
		expect(program.compilation?.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: run.functionIndex,
				code: "optimization.declined.generated-code-cost",
				outcome: "declined",
				reason: "generated-code-cost",
			}),
		);
	});

	it("records generated-code decline only from the final target graph", () => {
		const source = `function target(value) { return value + 1; }
			function caller(open, value) {
				let selected = open;
				if (true) selected = target;
				return selected(value);
			}
			caller(target, 1);`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"call-targets-final-decision.mjs",
			parseModule(source),
		);
		const conservative = conservativeCompilerProgramFacts();
		const initial = constructSemanticProgramCore(semantic, {
			collectOptimizationDiagnostics: true,
			facts: {
				...conservative,
				world: { ...conservative.world, realms: false },
			},
		});
		const initialCaller = initial.functions[functionIndexOfName(initial, "caller")]!;
		const [initialSite] = callSites(initialCaller);
		expect(
			analyzeCoreCalleeTargets(initial).targets(
				initialCaller.functionIndex,
				initialSite!.inputs[0]!,
			),
		).toMatchObject({
			functions: [functionIndexOfName(initial, "target")],
			opaque: true,
		});

		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		const caller = optimized.functions[functionIndexOfName(optimized, "caller")]!;
		const [site] = callSites(caller);
		expect(site?.attributes.directFunctionIndex).toBe(
			functionIndexOfName(optimized, "target"),
		);
		expect(optimized.compilation?.optimizationDecisions).not.toContainEqual(
			expect.objectContaining({
				functionIndex: caller.functionIndex,
				code: "optimization.declined.generated-code-cost",
			}),
		);
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

	it("resolves a method from a contained immutable service object", () => {
		const program = optimizedCore(
			`function run(value) { return value + 1; }
			const service = { run };
			function caller(value) { const callback = service.run; return callback(value); }
			caller(1);`,
			"call-targets-stable-service.mjs",
		);
		const methodIndex = functionIndexOfName(program, "run");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const sites = callSites(caller);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.attributes.directFunctionIndex).toBe(methodIndex);
		expect(calleeTargetsAttribute(sites[0]!)).toEqual({
			functions: [methodIndex],
			anyScript: false,
			opaque: false,
		});
	});

	it("keeps every in-program writer of a contained method cell", () => {
		const program = optimizedCore(
			`function first(value) { return value + 1; }
			function second(value) { return value + 2; }
			const service = { run: first };
			service.run = second;
			function caller(value) { const callback = service.run; return callback(value); }
			caller(1);`,
			"call-targets-stable-service-retarget.mjs",
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const [site] = callSites(caller);
		expect(site?.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)?.functions).toEqual(
			[
				functionIndexOfName(program, "first"),
				functionIndexOfName(program, "second"),
			].sort((left, right) => left - right),
		);
		expect(calleeTargetsAttribute(site!)?.opaque).toBe(false);
	});

	it("leaves a mutable service binding open", () => {
		const program = optimizedCore(
			`let service = { run(value) { return value + 1; } };
			function caller(value) { const callback = service.run; return callback(value); }
			caller(1);`,
			"call-targets-mutable-service.mjs",
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const [site] = callSites(caller);
		expect(site?.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)).toBeUndefined();
	});

	it("keeps guarded candidates from an escaped service object", () => {
		const program = optimizedCore(
			`function run(value) { return value + 1; }
			const service = { run };
			globalThis.saved = service;
			function caller(value) { const callback = service.run; return callback(value); }
			caller(1);`,
			"call-targets-escaped-service.mjs",
		);
		const target = functionIndexOfName(program, "run");
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const [site] = callSites(caller);
		expect(site?.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)).toEqual({
			functions: [target],
			anyScript: false,
			opaque: true,
		});
	});

	it("guards an own method before exposing its receiver to user code", () => {
		const program = optimizedCore(
			`function run(value) { this.saved = value; return value; }
			const service = { run };
			function caller(value) { return service.run(value); }
			caller(1);`,
			"call-targets-service-receiver.mjs",
		);
		const caller = program.functions[functionIndexOfName(program, "caller")]!;
		const [site] = callSites(caller);
		const target = functionIndexOfName(program, "run");
		expect(site?.attributes.directFunctionIndex).toBeUndefined();
		expect(calleeTargetsAttribute(site!)?.functions).toEqual([target]);
		expect(calleeTargetsAttribute(site!)?.opaque).toBe(true);
	});

	it("keeps global object cells open when realm installers are enabled", () => {
		const program = optimizedCore(
			`function run(value) { return value; }
			const service = { run };
			function caller(value) { const callback = service.run; return callback(value); }
			caller(1);`,
			"call-targets-service-realms.mjs",
		);
		const realmsProgram: CoreProgram = {
			...program,
			compilation: {
				...program.compilation!,
				facts: {
					...program.compilation!.facts,
					world: { ...program.compilation!.facts.world, realms: true },
				},
			},
		};
		const caller = realmsProgram.functions[functionIndexOfName(realmsProgram, "caller")]!;
		const property = caller.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "loadPropertyStatic")!;
		const targets = analyzeCoreCalleeTargets(realmsProgram).targets(
			caller.functionIndex,
			property.outputs[0]!,
		);
		expect(targets.functions).toEqual([]);
		expect(targets.opaque).toBe(true);
	});

	it("rejects malformed immutable-cell authority metadata", () => {
		const program = optimizedCore(
			`const callback = function callback(value) { return value; };
			callback(1);`,
			"call-targets-cell-metadata.mjs",
		);
		expect(program.compilation).toBeDefined();
		expect(() =>
			verifyCoreProgram(
				{
					...program,
					compilation: {
						...program.compilation!,
						singleAssignmentGlobalSlots: [program.globalCount],
					},
				},
				coreOpcodeRegistry,
			),
		).toThrow(/invalid single-assignment global slot/);
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

describe("bounded call-result targets", () => {
	it("declares which operand each control transfer enters and what its result is", () => {
		const declared = CORE_OPCODES.map(
			(opcode) => [opcode, coreOpcodeRegistry.require(opcode).callTransfer] as const,
		).filter(([, transfer]) => transfer !== undefined);
		// The registry is the single declaration a call has: an opcode missing here is
		// a call for neither the target lattice nor the interprocedural call graph.
		expect(Object.fromEntries(declared)).toEqual({
			call: { calleeOperand: 0, result: "call-completion" },
			callSpread: { calleeOperand: 0, result: "call-completion" },
			callSpreadIterable: { calleeOperand: 0, result: "call-completion" },
			construct: { calleeOperand: 0, result: "construct-completion" },
			constructSpread: { calleeOperand: 0, result: "construct-completion" },
			constructSuper: { calleeOperand: 0, result: "unmodeled" },
			constructSuperExplicit: { calleeOperand: 0, result: "unmodeled" },
		});
	});

	it("resolves a factory result to the single function the factory returns", () => {
		const program = optimizedCore(
			`function inner(value) { return value + 1; }
			function factory() { return inner; }
			function run(value) { return factory()(value); }
			run(1);`,
			"call-results-factory.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const resolved = callSites(run).filter(
			({ attributes }) => attributes.directFunctionIndex === innerIndex,
		);
		expect(resolved).toHaveLength(1);
		// A closed proof, not a speculation: nothing else can reach the result.
		expect(calleeTargetsAttribute(resolved[0]!)).toEqual({
			functions: [innerIndex],
			anyScript: false,
			opaque: false,
		});
	});

	it("keeps a bounded set for a factory that returns one of two functions", () => {
		const program = optimizedCore(
			`function first(value) { return value + 1; }
			function second(value) { return value + 2; }
			function pick(flag) { if (flag) { return first; } return second; }
			function run(flag, value) { return pick(flag)(value); }
			run(true, 1);`,
			"call-results-two.mjs",
		);
		const expected = [
			functionIndexOfName(program, "first"),
			functionIndexOfName(program, "second"),
		].sort((left, right) => left - right);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const site = callSites(run).find(
			({ attributes }) => attributes.directFunctionIndex === undefined,
		);
		expect(site).toBeDefined();
		expect(calleeTargetsAttribute(site!)?.functions).toEqual(expected);
		expect(calleeTargetsAttribute(site!)?.anyScript).toBe(false);
	});

	it("forwards every spread form's result through the same declaration", () => {
		const program = optimizedCore(
			`function inner(value) { return value + 1; }
			function factory() { return inner; }
			function iterable(args) { return factory(...args)(1); }
			function marshalled(args) { return factory(...args, 2)(1); }
			function constructed(args) { return new factory(...args); }
			iterable([]);
			marshalled([]);
			constructed([]);`,
			"call-results-spread.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const analysis = analyzeCoreCalleeTargets(program);
		const spreadResults = new Map<string, number | undefined>();
		for (const name of ["iterable", "marshalled", "constructed"]) {
			const fn = program.functions[functionIndexOfName(program, name)]!;
			for (const site of callLikeSites(fn)) {
				if (site.opcode === "call") continue;
				spreadResults.set(
					site.opcode,
					coreCalleeTargetsClosedFunction(
						analysis.targets(fn.functionIndex, site.outputs[0]!),
					),
				);
			}
		}
		expect(Object.fromEntries(spreadResults)).toEqual({
			callSpreadIterable: innerIndex,
			callSpread: innerIndex,
			constructSpread: innerIndex,
		});
	});

	it("keeps returned candidates alongside an unresolved callee fallback", () => {
		const program = optimizedCore(
			`function inner(value) { return value; }
			function factory() { return inner; }
			function run(flag, open, value) { return (flag ? factory : open)()(value); }
			run(true, factory, 1);`,
			"call-results-open.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const analysis = analyzeCoreCalleeTargets(program);
		const sites = callSites(run);
		expect(sites).toHaveLength(2);
		const returned = sites
			.map((site) => analysis.targets(run.functionIndex, site.outputs[0]!))
			.find(({ functions }) => functions.includes(innerIndex));
		expect(returned).toEqual({
			functions: [innerIndex],
			anyScript: false,
			opaque: true,
		});
		// The named return stays available to guarded consumers, while a residual
		// ordinary call does not add another speculative direct path.
		expect(
			sites.some(({ attributes }) => attributes.directFunctionIndex === innerIndex),
		).toBe(false);
	});

	it("hands back a promise rather than an async function's returned callable", () => {
		const program = optimizedCore(
			`function inner(value) { return value; }
			async function factory() { return inner; }
			function run(value) { return factory()(value); }
			run(1);`,
			"call-results-async.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const analysis = analyzeCoreCalleeTargets(program);
		// The body's return value is in the function's return cell, ...
		expect(analysis.returnTargets(functionIndexOfName(program, "factory"))).toEqual(
			coreCalleeTargetsFunction(innerIndex),
		);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		for (const site of callSites(run)) {
			// ... but calling it produces the result promise, which is not callable.
			expect(analysis.targets(run.functionIndex, site.outputs[0]!)).toEqual(
				CORE_CALLEE_TARGETS_BOTTOM,
			);
			expect(site.attributes.directFunctionIndex).not.toBe(innerIndex);
		}
	});

	it("hands back an iterator rather than a generator's returned callable", () => {
		const program = optimizedCore(
			`function inner(value) { return value; }
			function* factory() { return inner; }
			function run(value) { return factory()(value); }
			run(1);`,
			"call-results-generator.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const analysis = analyzeCoreCalleeTargets(program);
		expect(analysis.returnTargets(functionIndexOfName(program, "factory"))).toEqual(
			coreCalleeTargetsFunction(innerIndex),
		);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		for (const site of callSites(run)) {
			expect(analysis.targets(run.functionIndex, site.outputs[0]!)).toEqual(
				CORE_CALLEE_TARGETS_BOTTOM,
			);
			expect(site.attributes.directFunctionIndex).not.toBe(innerIndex);
		}
	});

	it("resolves a constructor's explicitly returned callable", () => {
		const program = optimizedCore(
			`function made(value) { return value; }
			function Factory() { return made; }
			function run(value) { return new Factory()(value); }
			run(1);`,
			"call-results-construct.mjs",
		);
		const madeIndex = functionIndexOfName(program, "made");
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const resolved = callSites(run).filter(
			({ opcode, attributes }) =>
				opcode === "call" && attributes.directFunctionIndex === madeIndex,
		);
		expect(resolved).toHaveLength(1);
		expect(calleeTargetsAttribute(resolved[0]!)).toEqual({
			functions: [madeIndex],
			anyScript: false,
			opaque: false,
		});
	});

	it("leaves a derived constructor's completion open", () => {
		const program = optimizedCore(
			`class Base { constructor() { return function fromBase() { return 1; }; } }
			class Derived extends Base { constructor() { super(); } }
			function run() { return new Derived()(); }
			run();`,
			"call-results-derived.mjs",
		);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		const analysis = analyzeCoreCalleeTargets(program);
		const construct = callSites(run).find(({ opcode }) => opcode === "construct");
		expect(construct).toBeDefined();
		// [[Construct]] substitutes the object this constructor's own super() bound
		// whenever the body returns a non-object, and no Core value names it.
		expect(analysis.targets(run.functionIndex, construct!.outputs[0]!)).toEqual(
			CORE_CALLEE_TARGETS_OPAQUE,
		);
	});

	it("widens a return cell past the cap instead of picking a subset", () => {
		const returns = Array.from(
			{ length: CORE_CALLEE_TARGET_CAP + 1 },
			(_, index) => `if (which === ${index}) { return candidate${index}; }`,
		).join("\n");
		const declarations = Array.from(
			{ length: CORE_CALLEE_TARGET_CAP + 1 },
			(_, index) => `function candidate${index}() { return ${index}; }`,
		).join("\n");
		const program = optimizedCore(
			`${declarations}
			function pick(which) { ${returns} return candidate0; }
			function run(which) { return pick(which)(); }
			run(0);`,
			"call-results-cap.mjs",
		);
		const analysis = analyzeCoreCalleeTargets(program);
		const returnCell = analysis.returnTargets(functionIndexOfName(program, "pick"));
		expect(returnCell.functions).toEqual([]);
		expect(returnCell.anyScript).toBe(true);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		for (const site of callSites(run)) {
			expect(site.attributes.directFunctionIndex).not.toBe(
				functionIndexOfName(program, "candidate0"),
			);
		}
	});

	it("converges on a recursive factory and bounds its call activations", () => {
		const program = optimizedCore(
			`function inner(value) { return value; }
			function factory(depth) { if (depth > 0) { return factory(depth - 1); } return inner; }
			function run(value) { return factory(3)(value); }
			run(1);`,
			"call-results-recursive.mjs",
		);
		const innerIndex = functionIndexOfName(program, "inner");
		const analysis = analyzeCoreCalleeTargets(program);
		expect(analysis.returnTargets(functionIndexOfName(program, "factory"))).toEqual(
			coreCalleeTargetsFunction(innerIndex),
		);
		const run = program.functions[functionIndexOfName(program, "run")]!;
		expect(
			callSites(run).filter(
				({ attributes }) => attributes.directFunctionIndex === innerIndex,
			),
		).toHaveLength(1);
		const declaredCalls = program.functions.reduce(
			(total, fn) => total + callLikeSites(fn).length,
			0,
		);
		// Each site wires at most one return cell per finite target plus one raise for
		// each open component; a solver that rescanned calls would exceed this.
		expect(analysis.statistics.callActivations).toBeLessThanOrEqual(
			declaredCalls * (CORE_CALLEE_TARGET_CAP + 2),
		);
	});

	it("opens a call whose named target is not part of this program", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		// A target index no function in the program carries: the return cell it would
		// need does not exist, so the result cannot be narrowed at all.
		const [callee] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 9 },
		});
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, receiver!]);
		builder.setTerminator(entry, { kind: "return", value: result! });

		const analysis = analyzeCoreCalleeTargets(coreProgram([builder.finish(entry)]));
		expect(analysis.targets(0, result!)).toEqual(CORE_CALLEE_TARGETS_OPAQUE);
	});
});
