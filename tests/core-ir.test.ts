import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import {
	CoreMemoryLocationTable,
	analyzeCoreMemoryVersions,
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
} from "../src/compiler/core/core-ir-memory.ts";
import {
	CORE_OPCODES,
	coreOpcodeRegistry,
} from "../src/compiler/core/core-ir-opcodes.ts";
import {
	buildCoreLocalFactIndex,
	coreOwnCellResolver,
} from "../src/compiler/core/core-ir-provenance.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import type {
	CoreFactClaim,
	CoreFunctionId,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import {
	CORE_MEMORY_FAMILIES,
	CORE_MEMORY_FAMILY_DOMAINS,
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
	coreValueId,
	formatCoreFunction,
} from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

function registry(): CoreOpcodeRegistry {
	const registry = new CoreOpcodeRegistry();
	registry.define({
		opcode: "constant",
		inputs: coreArity(0),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	registry.define({
		opcode: "add",
		inputs: coreArity(2),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	registry.define({
		opcode: "move",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	registry.define({
		opcode: "call",
		inputs: coreArity(1, 16),
		outputs: coreArity(1),
		effects: {
			reads: ["global-property", "object-property"],
			writes: ["global-property", "object-property"],
			mayThrow: true,
			maySuspend: false,
			mayGc: true,
			callsUserCode: true,
		},
		discardable: false,
		attributeRelocations: [],
	});
	return registry;
}

describe("Core IR", () => {
	it("reuses own-cell canonicalization until the string table grows", () => {
		const constants = [[0x6b], [0x6b]];
		const first = coreOwnCellResolver(constants);

		expect(first(0)).toEqual({ kind: "object-slot", key: 0 });
		expect(first(1)).toEqual({ kind: "object-slot", key: 0 });
		expect(coreOwnCellResolver(constants)).toBe(first);

		constants.push([0x31]);
		const grown = coreOwnCellResolver(constants);
		expect(grown).not.toBe(first);
		expect(grown(2)).toEqual({ kind: "element", index: 1 });
	});

	it("keeps structural control out of opcodes and enforces exact arities", () => {
		expect(CORE_OPCODES).not.toEqual(
			expect.arrayContaining([
				"catch",
				"jump",
				"jumpIf",
				"return",
				"sourcePos",
				"throw",
				"tryBegin",
				"tryEnd",
			]),
		);
		expect(coreOpcodeRegistry.require("binary").inputs).toEqual({
			minimum: 2,
			maximum: 2,
		});
		expect(coreOpcodeRegistry.require("call").inputs).toEqual({
			minimum: 2,
			maximum: 65_535,
		});
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		expect(() =>
			builder.appendInstruction(entry, "binary", [
				inspectCoreBlockParameters(builder, entry)[0]!.value,
			]),
		).toThrow(/binary expects 2\.\.2 inputs/);
	});

	it("names every declared access against the effect domains it belongs to", () => {
		for (const descriptor of coreOpcodeRegistry.entries()) {
			for (const access of descriptor.accesses ?? []) {
				const declared =
					access.mode === "read" ? descriptor.effects.reads : descriptor.effects.writes;
				for (const domain of CORE_MEMORY_FAMILY_DOMAINS[access.family]) {
					expect(declared).toContain(domain);
				}
			}
		}
		// Families that can describe the same cell must share a domain, so one
		// family's write is never invisible to another family's reader.
		for (const family of CORE_MEMORY_FAMILIES) {
			expect(CORE_MEMORY_FAMILY_DOMAINS[family].length).toBeGreaterThan(0);
		}
		expect(CORE_MEMORY_FAMILY_DOMAINS["global-property"]).toContain("object-property");
		expect(CORE_MEMORY_FAMILY_DOMAINS.element).toContain("object-property");
		expect(CORE_MEMORY_FAMILIES).not.toContain("string");
		expect(CORE_MEMORY_FAMILIES).not.toContain("epoch");
	});

	it("rejects a descriptor whose access and effect domains disagree", () => {
		const opcodes = new CoreOpcodeRegistry();
		expect(() =>
			opcodes.define({
				opcode: "undeclaredSlotWrite",
				inputs: coreArity(1),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				attributeRelocations: [],
				accesses: [{ family: "global-slot", mode: "write", valueOperand: 0 }],
			}),
		).toThrow(/without declaring the global-slot effect domain/);
		expect(() =>
			opcodes.define({
				opcode: "outOfRangeValueOperand",
				inputs: coreArity(1),
				outputs: coreArity(0),
				effects: { ...CORE_NO_EFFECTS, writes: ["global-slot"] },
				discardable: false,
				attributeRelocations: [],
				accesses: [{ family: "global-slot", mode: "write", valueOperand: 3 }],
			}),
		).toThrow(/value operand 3 outside its 1\.\.1 inputs/);
		expect(() =>
			opcodes.define({
				opcode: "basedActivationSlot",
				inputs: coreArity(1),
				outputs: coreArity(1),
				effects: { ...CORE_NO_EFFECTS, reads: ["captured-slot"] },
				discardable: true,
				attributeRelocations: [],
				accesses: [{ family: "captured-slot", mode: "read", baseOperand: 0 }],
			}),
		).toThrow(/base or key for the activation-local family captured-slot/);
	});

	it("requires an explicit local-ID relocation contract for every opcode", () => {
		const opcodes = new CoreOpcodeRegistry();
		expect(() =>
			opcodes.define({
				opcode: "missingRelocations",
				inputs: coreArity(0),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: true,
			} as never),
		).toThrow("must declare attribute relocation contracts");
		expect(() =>
			opcodes.define({
				opcode: "duplicateRelocations",
				inputs: coreArity(0),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: true,
				attributeRelocations: [
					{ path: ["owner"], kind: "block", cardinality: "one" },
					{ path: ["owner"], kind: "value", cardinality: "one" },
				],
			}),
		).toThrow("repeats attribute relocation path owner");
	});

	it("resolves exact compiler-slot locations and degrades heap accesses to a family", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [slot] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 4 },
		});
		builder.appendInstruction(entry, "loadCaptured", [], {
			attributes: { functionIndex: 2, index: 1 },
		});
		const [self] = builder.appendInstruction(entry, "loadThis", []);
		// A store keeps its exact slot identity and names the value it forwards.
		builder.appendInstruction(entry, "storeGlobal", [slot!], {
			attributes: { index: 4 },
		});
		// A malformed slot attribute must widen to the family, never guess a cell.
		builder.appendInstruction(entry, "storeGlobal", [slot!], {
			attributes: { index: "four" },
		});
		const [property] = builder.appendInstruction(entry, "loadPropertyStatic", [self!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: property! });
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);
		const instructions = builder.bodyInstructionIds(entry);
		const locationOf = (index: number) =>
			coreMemoryAccesses(fn, instructions[index]!)[0]!;

		expect(locationOf(0).location).toEqual({ kind: "global-slot", slot: 4 });
		expect(locationOf(1).location).toEqual({
			kind: "captured-slot",
			owner: 2,
			index: 1,
		});
		expect(locationOf(2).location).toEqual({ kind: "activation-this" });
		expect(locationOf(3)).toMatchObject({ mode: "write", value: slot });
		expect(locationOf(4).location).toEqual({ kind: "family", family: "global-slot" });
		const heap = locationOf(5);
		expect(coreMemoryLocationIsExact(heap.location)).toBe(false);
		expect(coreMemoryLocationFamily(heap.location)).toBe("object-slot");
		// The declared base and key are recorded for the future alias oracle without
		// making the partition itself narrower than the whole family.
		expect(heap).toMatchObject({
			base: self,
			key: { kind: "string-constant", index: 0 },
		});
		const locations = new CoreMemoryLocationTable();
		expect(locations.id({ kind: "global-slot", slot: 4 })).not.toBe(
			locations.id({ kind: "global-slot", slot: 5 }),
		);
		expect(locations.id({ kind: "local-slot", slot: 4 })).not.toBe(
			locations.id({ kind: "global-slot", slot: 4 }),
		);
	});

	it("stores only observed memory versions at read checkpoints", () => {
		const exactReadCount = 32;
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: exactReadCount,
		});
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		let returned: CoreValueId | undefined;
		for (let index = 0; index < exactReadCount; index++) {
			[returned] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index },
			});
		}
		builder.setTerminator(entry, { kind: "return", value: returned! });
		const { function: functionId } = builder.finish(entry);

		const memory = analyzeCoreMemoryVersions(program, functionId);

		expect(memory.statistics).toMatchObject({ accesses: 0, solvedPartitions: 0 });
		for (const instruction of builder.bodyInstructionIds(entry))
			memory.readHash(instruction);
		expect(memory.statistics.partitions).toBe(exactReadCount);
		expect(memory.statistics.stateEntries).toBe(exactReadCount * 2);
	});

	it("solves only queried exact locations and keeps answers stable after other queries", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 32 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		for (let index = 0; index < 32; index++) {
			builder.appendInstruction(entry, "storeGlobal", [stored!], {
				attributes: { index },
			});
			builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index } });
		}
		const [last] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: last! });
		const { function: id } = builder.finish(entry);
		const fn = program.function(id);
		const reads = [...fn.bodyInstructionIds(entry)].filter(
			(i) => fn.instructionOpcodeName(i) === "loadGlobal",
		);
		const memory = analyzeCoreMemoryVersions(program, id);
		expect(memory.statistics.accesses).toBe(0);
		expect(memory.valueForRead(reads[0]!, { kind: "global-slot", slot: 0 })).toBe(stored);
		expect(memory.statistics.solvedPartitions).toBe(2);
		const hash = memory.readHash(reads[0]!);
		expect(memory.readsEquivalent(reads[0]!, reads.at(-1)!)).toBe(true);
		expect(memory.statistics.solvedPartitions).toBe(2);
		expect(memory.valueForRead(reads[1]!, { kind: "global-slot", slot: 1 })).toBe(stored);
		expect(memory.statistics.solvedPartitions).toBe(3);
		expect(memory.readHash(reads[0]!)).toBe(hash);
		const reversed = analyzeCoreMemoryVersions(program, id);
		expect(reversed.valueForRead(reads[1]!, { kind: "global-slot", slot: 1 })).toBe(
			stored,
		);
		expect(reversed.readsEquivalent(reads[0]!, reads.at(-1)!)).toBe(true);
		expect(reversed.valueForRead(reads[0]!, { kind: "global-slot", slot: 0 })).toBe(
			stored,
		);
	});

	it.each(
		[false, true].flatMap((prepared) =>
			["body", "data"].map((change) => ({ prepared, change })),
		),
	)(
		"rejects stale memory queries after $change edits, prepared=$prepared",
		({ prepared, change }) => {
			const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: value! });
			const { function: id } = builder.finish(entry);
			const read = builder.bodyInstructionIds(entry)[0]!;
			const memory = analyzeCoreMemoryVersions(program, id);
			if (prepared) memory.readHash(read);
			const editor = CoreEditor.open(program, id);
			if (change === "body")
				editor.replaceInstruction(read, "loadGlobal", [], { attributes: { index: 1 } });
			else editor.appendStringConstants([[120]]);
			editor.commit();
			expect(() => memory.readHash(read)).toThrow("Stale memory-version analysis");
			expect(() => memory.readsEquivalent(read, read)).toThrow(
				"Stale memory-version analysis",
			);
			expect(() => memory.valueForRead(read, { kind: "global-slot", slot: 0 })).toThrow(
				"Stale memory-version analysis",
			);
		},
	);

	it("retains stores for locations queried after the shared call barriers are solved", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.appendInstruction(entry, "storeGlobal", [stored!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } });
		const before = builder.bodyInstructionIds(entry).at(-1)!;
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.appendInstruction(entry, "storeGlobal", [stored!], {
			attributes: { index: 1 },
		});
		builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 1 } });
		const restored = builder.bodyInstructionIds(entry).at(-1)!;
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const clobbered = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const memory = analyzeCoreMemoryVersions(program, builder.finish(entry).function);
		expect(memory.valueForRead(before, { kind: "global-slot", slot: 0 })).toBe(stored);
		expect(memory.valueForRead(restored, { kind: "global-slot", slot: 1 })).toBe(stored);
		expect(
			memory.valueForRead(clobbered, { kind: "global-slot", slot: 0 }),
		).toBeUndefined();
	});

	it.each(["call", "suspend"] as const)(
		"compacts %s clobbers without losing slot checkpoints",
		(clobber) => {
			const opcodes = new CoreOpcodeRegistry();
			for (const opcode of CORE_OPCODES)
				opcodes.define(coreOpcodeRegistry.require(opcode));
			opcodes.define({
				opcode: "suspend",
				inputs: coreArity(0),
				outputs: coreArity(0),
				effects: { ...CORE_NO_EFFECTS, maySuspend: true },
				discardable: false,
				attributeRelocations: [],
			});
			opcodes.define({
				opcode: "readGlobals",
				inputs: coreArity(0),
				outputs: coreArity(1),
				effects: { ...CORE_NO_EFFECTS, reads: ["global-slot"] },
				discardable: true,
				attributeRelocations: [],
				accesses: [{ family: "global-slot", mode: "read" }],
			});
			const program = new CoreProgram(opcodes, { globalCount: 2 });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [stored] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const read = (opcode: string, attributes = {}) => {
				builder.appendInstruction(entry, opcode, [], { attributes });
				return builder.bodyInstructionIds(entry).at(-1)!;
			};
			const clobberMany = () => {
				for (let i = 0; i < 12; i++)
					builder.appendInstruction(
						entry,
						clobber,
						clobber === "call" ? [stored!, stored!] : [],
					);
			};
			builder.appendInstruction(entry, "storeGlobal", [stored!], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(entry, "storeCaptured", [stored!], {
				attributes: { functionIndex: 0, index: 0 },
			});
			const before = read("loadGlobal", { index: 0 });
			const capturedBefore = read("loadCaptured", { functionIndex: 0, index: 0 });
			const domainBefore = read("readGlobals");
			clobberMany();
			builder.appendInstruction(entry, "storeGlobal", [stored!], {
				attributes: { index: 1 },
			});
			const restored = read("loadGlobal", { index: 1 });
			clobberMany();
			const after = read("loadGlobal", { index: 0 });
			const otherAfter = read("loadGlobal", { index: 1 });
			const capturedAfter = read("loadCaptured", { functionIndex: 0, index: 0 });
			const domainAfter = read("readGlobals");
			builder.setTerminator(entry, { kind: "return", value: stored! });
			const memory = analyzeCoreMemoryVersions(program, builder.finish(entry).function);
			expect(memory.valueForRead(before, { kind: "global-slot", slot: 0 })).toBe(stored);
			const hash = memory.readHash(before);
			expect(
				memory.valueForRead(after, { kind: "global-slot", slot: 0 }),
			).toBeUndefined();
			expect(memory.valueForRead(restored, { kind: "global-slot", slot: 1 })).toBe(
				stored,
			);
			expect(
				memory.valueForRead(otherAfter, { kind: "global-slot", slot: 1 }),
			).toBeUndefined();
			expect(
				memory.valueForRead(capturedBefore, {
					kind: "captured-slot",
					owner: 0,
					index: 0,
				}),
			).toBe(stored);
			expect(
				memory.valueForRead(capturedAfter, { kind: "captured-slot", owner: 0, index: 0 }),
			).toBeUndefined();
			expect(memory.readsEquivalent(domainBefore, domainAfter)).toBe(false);
			expect(memory.readHash(before)).toBe(hash);
			expect(memory.statistics.compactedEvents).toBeGreaterThanOrEqual(22);
		},
	);

	it.each([false, true])(
		"keeps read/write checkpoints before an unknown exact writer=%s",
		(unknown) => {
			const opcodes = new CoreOpcodeRegistry();
			for (const opcode of CORE_OPCODES)
				opcodes.define(coreOpcodeRegistry.require(opcode));
			opcodes.define({
				opcode: "exchangeGlobal",
				inputs: coreArity(1),
				outputs: coreArity(1),
				effects: { ...CORE_NO_EFFECTS, reads: ["global-slot"], writes: ["global-slot"] },
				discardable: false,
				attributeRelocations: [],
				accesses: [
					{ family: "global-slot", mode: "read", attributes: ["index"] },
					{
						family: "global-slot",
						mode: "write",
						attributes: ["index"],
						valueOperand: 0,
					},
				],
			});
			opcodes.define({
				opcode: "unknownGlobal",
				inputs: coreArity(0),
				outputs: coreArity(0),
				effects: { ...CORE_NO_EFFECTS, writes: ["global-slot"] },
				discardable: false,
				attributeRelocations: [],
				accesses: [{ family: "global-slot", mode: "write", attributes: ["index"] }],
			});
			const program = new CoreProgram(opcodes, { globalCount: 1 });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [first] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [second] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 2 },
			});
			for (const value of [first!, second!])
				builder.appendInstruction(entry, "storeGlobal", [value], {
					attributes: { index: 0 },
				});
			builder.appendInstruction(entry, "exchangeGlobal", [first!], {
				attributes: { index: 0 },
			});
			const exchange = builder.bodyInstructionIds(entry).at(-1)!;
			builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } });
			const afterExchange = builder.bodyInstructionIds(entry).at(-1)!;
			builder.appendInstruction(entry, "storeGlobal", [second!], {
				attributes: { index: 0 },
			});
			if (unknown)
				builder.appendInstruction(entry, "unknownGlobal", [], {
					attributes: { index: 0 },
				});
			builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } });
			const final = builder.bodyInstructionIds(entry).at(-1)!;
			builder.setTerminator(entry, { kind: "return", value: first! });
			const memory = analyzeCoreMemoryVersions(program, builder.finish(entry).function);
			const location = { kind: "global-slot", slot: 0 } as const;
			expect(memory.valueForRead(exchange, location)).toBe(second);
			expect(memory.valueForRead(afterExchange, location)).toBe(first);
			expect(memory.valueForRead(final, location)).toBe(unknown ? undefined : second);
			expect(memory.statistics.compactedEvents).toBeGreaterThan(0);
		},
	);

	it.each(["loop", "handler"] as const)(
		"preserves reaching writes across a %s with compacted clobbers",
		(flow) => {
			const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const body = builder.createBlock(),
				exit = builder.createBlock(
					flow === "handler" ? [{ role: "exception", representation: "boxed" }] : [],
				);
			const [initial] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 2 },
			});
			builder.appendInstruction(entry, "storeGlobal", [initial!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: body, arguments: [] },
			});
			builder.appendInstruction(body, "loadGlobal", [], { attributes: { index: 0 } });
			const before = builder.bodyInstructionIds(body).at(-1)!;
			for (let i = 0; i < 3; i++)
				builder.appendInstruction(body, "call", [initial!, initial!]);
			builder.appendInstruction(body, "storeGlobal", [replacement!], {
				attributes: { index: 0 },
			});
			const [after] = builder.appendInstruction(body, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			const afterInstruction = builder.bodyInstructionIds(body).at(-1)!;
			if (flow === "loop")
				builder.setTerminator(body, {
					kind: "branch",
					condition: builder.blockParameterValue(entry, 0),
					consequent: { block: body, arguments: [] },
					alternate: { block: exit, arguments: [] },
				});
			else {
				builder.setHandler(body, exit, []);
				builder.setTerminator(body, { kind: "return", value: after! });
			}
			const [loaded] = builder.appendInstruction(exit, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			const final = builder.bodyInstructionIds(exit).at(-1)!;
			builder.setTerminator(exit, { kind: "return", value: loaded! });
			const memory = analyzeCoreMemoryVersions(program, builder.finish(entry).function);
			const location = { kind: "global-slot", slot: 0 } as const;
			expect(memory.valueForRead(before, location)).toBe(
				flow === "loop" ? undefined : initial,
			);
			expect(memory.valueForRead(afterInstruction, location)).toBe(replacement);
			expect(memory.valueForRead(final, location)).toBe(
				flow === "loop" ? replacement : undefined,
			);
			expect(memory.statistics.compactedEvents).toBeGreaterThan(0);
		},
	);

	it("includes refined element writes when the array domain is queried first", () => {
		const registry = new CoreOpcodeRegistry();
		for (const opcode of CORE_OPCODES) {
			const descriptor = coreOpcodeRegistry.require(opcode);
			registry.define(
				["loadProperty", "storeProperty", "defineProperty"].includes(opcode)
					? { ...descriptor, effects: { ...descriptor.effects, callsUserCode: false } }
					: descriptor,
			);
		}
		registry.define({
			opcode: "readElements",
			inputs: coreArity(0),
			outputs: coreArity(1),
			effects: { ...CORE_NO_EFFECTS, reads: ["object-property", "array-element"] },
			accesses: [{ family: "element", mode: "read" }],
			discardable: true,
			attributeRelocations: [],
		});
		registry.define({
			opcode: "clobberElements",
			inputs: coreArity(0),
			outputs: coreArity(0),
			effects: { ...CORE_NO_EFFECTS, writes: ["array-element"] },
			discardable: false,
			attributeRelocations: [],
		});
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const [index] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 1 },
		});
		builder.appendInstruction(entry, "defineProperty", [array!, index!, value!]);
		builder.appendInstruction(entry, "readElements", []);
		const before = builder.bodyInstructionIds(entry).at(-1)!;
		builder.appendInstruction(entry, "storeProperty", [array!, index!, value!]);
		builder.appendInstruction(entry, "readElements", []);
		const after = builder.bodyInstructionIds(entry).at(-1)!;
		builder.appendInstruction(entry, "clobberElements", []);
		builder.appendInstruction(entry, "readElements", []);
		const clobbered = builder.bodyInstructionIds(entry).at(-1)!;
		const [loaded] = builder.appendInstruction(entry, "loadProperty", [array!, index!]);
		const exact = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const id = builder.finish(entry).function;
		const memory = analyzeCoreMemoryVersions(program, id);
		expect(memory.readHash(before)).toBeDefined();
		expect(memory.statistics.heapAccessesResolved).toBe(3);
		expect(memory.readsEquivalent(before, after)).toBe(false);
		expect(memory.readsEquivalent(after, clobbered)).toBe(false);
		const reversed = analyzeCoreMemoryVersions(program, id);
		expect(reversed.readHash(exact)).toBeDefined();
		expect(reversed.readsEquivalent(before, after)).toBe(false);
	});

	it("does not materialize write-only memory events", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		for (let index = 0; index < 32; index++) {
			builder.appendInstruction(entry, "storeLocal", [stored!], {
				attributes: { index },
			});
		}
		builder.setTerminator(entry, { kind: "return", value: stored! });
		const { function: functionId } = builder.finish(entry);

		const memory = analyzeCoreMemoryVersions(program, functionId);

		memory.readHash(builder.bodyInstructionIds(entry)[0]!);
		expect(memory.statistics).toMatchObject({
			accesses: 32,
			touchedBlocks: 0,
			stateRows: 0,
			stateEntries: 0,
			familyWidenings: 0,
		});
	});

	it("indexes memory work independently of unrelated operations", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		for (let index = 0; index < 2_000; index++) {
			builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: index },
			});
		}
		const [returned] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: returned! });
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);
		const control = buildCoreControlFlow(program, functionId);
		const roots = coreCanonicalValueRoots(fn, control);

		const index = buildCoreLocalFactIndex(fn, roots);
		const memory = analyzeCoreMemoryVersions(program, functionId);

		memory.readHash(builder.bodyInstructionIds(entry).at(-1)!);
		expect(index.statistics).toMatchObject({
			operations: 2_001,
		});
		expect(memory.statistics).toMatchObject({
			indexedInstructions: 2_001,
			accesses: 1,
			touchedBlocks: 1,
			stateRows: 1,
			stateEntries: 2,
			familyWidenings: 0,
		});
	});

	it("counts exact locations widened by unknown calls", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [stored] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(entry, "storeGlobal", [stored!], {
			attributes: { index: 0 },
		});
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "call", [callee!, callee!]);
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const { function: functionId } = builder.finish(entry);

		const memory = analyzeCoreMemoryVersions(program, functionId);

		const read = builder.bodyInstructionIds(entry).at(-1)!;
		expect(memory.valueForRead(read, { kind: "global-slot", slot: 0 })).toBeUndefined();
		expect(memory.statistics.familyWidenings).toBe(1);
	});

	it("declares a fresh aggregate's layout and which results cannot be held weakly", () => {
		const shaped = coreOpcodeRegistry.require("createObjectShaped");
		expect(shaped.allocation).toStrictEqual({
			kind: "named-slots",
			keysAttribute: "keyStringIndices",
			firstValueOperand: 0,
		});
		expect(coreOpcodeRegistry.require("createObject").allocation).toEqual({
			kind: "empty-object",
		});
		// No JavaScript operator evaluates to an object or a symbol, so an operator
		// result's reachability is never observable; an intrinsic can be a well-known
		// symbol, which a registry accepts.
		expect(coreOpcodeRegistry.require("binary").resultCannotBeHeldWeakly).toBe(true);
		expect(coreOpcodeRegistry.require("unary").resultCannotBeHeldWeakly).toBe(true);
		expect(
			coreOpcodeRegistry.require("loadIntrinsic").resultCannotBeHeldWeakly,
		).toBeUndefined();
		expect(
			coreOpcodeRegistry.require("createObjectShaped").resultCannotBeHeldWeakly,
		).toBeUndefined();
		const generatorStart = coreOpcodeRegistry.require("generatorStart").effects;
		expect(generatorStart).toMatchObject({
			maySuspend: true,
			mayGc: true,
			mayThrow: true,
			callsUserCode: true,
		});
		expect(generatorStart.reads).toContain("object-property");
		const asyncStart = coreOpcodeRegistry.require("asyncStart").effects;
		expect(asyncStart).toMatchObject({
			maySuspend: false,
			mayGc: true,
			mayThrow: false,
			callsUserCode: false,
		});
		const opcodes = new CoreOpcodeRegistry();
		expect(() =>
			opcodes.define({
				opcode: "unnamedLayout",
				inputs: coreArity(0, 4),
				outputs: coreArity(1),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				attributeRelocations: [],
				allocation: {
					kind: "named-slots",
					keysAttribute: "",
					firstValueOperand: 0,
				},
			}),
		).toThrow(/allocation with no key attribute/);
		expect(() =>
			opcodes.define({
				opcode: "referencelessLayout",
				inputs: coreArity(0, 4),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				attributeRelocations: [],
				allocation: {
					kind: "named-slots",
					keysAttribute: "keys",
					firstValueOperand: 0,
				},
			}),
		).toThrow(/without producing a reference/);
	});

	it("builds, verifies, prints, and analyzes block-parameter SSA", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const merge = builder.createBlock([{ representation: "f64" }]);
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [left] = builder.appendInstruction(consequent, "constant", [], {
			outputRepresentations: ["f64"],
			attributes: { value: 1 },
		});
		const [right] = builder.appendInstruction(alternate, "constant", [], {
			outputRepresentations: ["f64"],
			attributes: { value: 2 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: consequent, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		builder.setTerminator(consequent, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(alternate, {
			kind: "jump",
			edge: { block: merge, arguments: [right!] },
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, merge)[0]!.value,
		});
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);

		expect(() => verifyCoreFunction(program, functionId)).not.toThrow();
		const cfg = buildCoreControlFlow(program, functionId);
		expect(cfg.dominates(entry, merge)).toBe(true);
		expect(cfg.dominates(consequent, merge)).toBe(false);
		const canonical = coreCanonicalValueRoots(fn, cfg);
		const mergeValue = inspectCoreBlockParameters(builder, merge)[0]!.value;
		expect(canonical.get(mergeValue)).toBe(mergeValue);
		expect(canonical.get(mergeValue)).not.toBe(canonical.get(left!));
		expect(canonical.get(mergeValue)).not.toBe(canonical.get(right!));
		expect(formatCoreFunction(program, functionId)).toContain("branch %0, b1(), b2()");
		expect(formatCoreFunction(program, functionId)).toContain("b3(%1: f64)");
	});

	it("canonicalizes moves and loop-carried copies to their external producer", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const header = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock();
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const loopValue = inspectCoreBlockParameters(builder, header)[0]!.value;
		const [moved] = builder.appendInstruction(body, "move", [loopValue]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [input] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: input,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [loopValue] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [moved!] },
		});
		const result = inspectCoreBlockParameters(builder, exit)[0]!.value;
		builder.setTerminator(exit, { kind: "return", value: result });
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);

		expect(() => verifyCoreFunction(program, functionId)).not.toThrow();
		const canonical = coreCanonicalValueRoots(
			fn,
			buildCoreControlFlow(program, functionId),
		);
		expect(canonical.get(loopValue)).toBe(input);
		expect(canonical.get(moved!)).toBe(input);
		expect(canonical.get(result)).toBe(input);
	});

	it("canonicalizes a mutually recursive phi component with one external producer", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const header = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const body = builder.createBlock();
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const [left, right] = inspectCoreBlockParameters(builder, header).map(
			({ value }) => value,
		);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [input!, input!] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [left!] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [right!, left!] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, exit)[0]!.value,
		});
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);

		expect(() => verifyCoreFunction(program, functionId)).not.toThrow();
		const canonical = coreCanonicalValueRoots(
			fn,
			buildCoreControlFlow(program, functionId),
		);
		expect(canonical.get(left!)).toBe(input);
		expect(canonical.get(right!)).toBe(input);
	});

	it("rejects values that do not dominate an incoming edge", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const leftBlock = builder.createBlock();
		const rightBlock = builder.createBlock();
		const merge = builder.createBlock([{ representation: "boxed" }]);
		const [left] = builder.appendInstruction(leftBlock, "constant", []);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: inspectCoreBlockParameters(builder, entry)[0]!.value,
			consequent: { block: leftBlock, arguments: [] },
			alternate: { block: rightBlock, arguments: [] },
		});
		builder.setTerminator(leftBlock, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(rightBlock, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, merge)[0]!.value,
		});
		const { function: functionId } = builder.finish(entry);

		expect(() => verifyCoreFunction(program, functionId)).toThrow(
			/does not dominate its use .* in b2/,
		);
	});

	it("models exception flow with a block-entry handler contract", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([
			{ role: "exception", representation: "boxed" },
			{ representation: "boxed" },
		]);
		const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [result] = builder.appendInstruction(entry, "call", [input]);
		builder.setHandler(entry, handler, [input]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.setTerminator(handler, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, handler)[1]!.value,
		});
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);

		expect(() => verifyCoreFunction(program, functionId)).not.toThrow();
		expect(buildCoreControlFlow(program, functionId).successors[entry]).toEqual([
			expect.objectContaining({ to: handler, kind: "exceptional" }),
		]);
		const canonical = coreCanonicalValueRoots(
			fn,
			buildCoreControlFlow(program, functionId),
		);
		expect(canonical.get(inspectCoreBlockParameters(builder, handler)[1]!.value)).toBe(
			input,
		);

		const invalidProgram = new CoreProgram(opcodes);
		const invalid = new CoreFunctionBuilder(invalidProgram, { parameterCount: 1 });
		const invalidEntry = invalid.createBlock([{ representation: "boxed" }]);
		const invalidHandler = invalid.createBlock([
			{ role: "exception" },
			{ representation: "boxed" },
		]);
		const [late] = invalid.appendInstruction(
			invalidEntry,
			"call",
			[inspectCoreBlockParameters(invalid, invalidEntry)[0]!.value],
			{
				outputCount: 1,
			},
		);
		invalid.setHandler(invalidEntry, invalidHandler, [late!]);
		invalid.setTerminator(invalidEntry, { kind: "return", value: late! });
		invalid.setTerminator(invalidHandler, {
			kind: "return",
			value: inspectCoreBlockParameters(invalid, invalidHandler)[1]!.value,
		});
		const { function: invalidFunction } = invalid.finish(invalidEntry);
		expect(() => verifyCoreFunction(invalidProgram, invalidFunction)).toThrow(
			/unavailable on b0's exception edge/,
		);

		const directProgram = new CoreProgram(opcodes);
		const direct = new CoreFunctionBuilder(directProgram, { parameterCount: 1 });
		const directEntry = direct.createBlock([{ representation: "boxed" }]);
		const directHandler = direct.createBlock([{ role: "exception" }]);
		const [directLate] = direct.appendInstruction(directEntry, "call", [
			inspectCoreBlockParameters(direct, directEntry)[0]!.value,
		]);
		direct.setHandler(directEntry, directHandler);
		direct.setTerminator(directEntry, { kind: "return", value: directLate! });
		direct.setTerminator(directHandler, { kind: "return", value: directLate! });
		const { function: directFunction } = direct.finish(directEntry);
		expect(() => verifyCoreFunction(directProgram, directFunction)).toThrow(
			/does not dominate its use .* in b1/,
		);

		// A defining block can dominate a protected block even though an exception
		// leaves it before the definition and later reaches that block. Handler
		// arguments need instruction-exit dominance, not ordinary block dominance.
		const exceptionalProgram = new CoreProgram(opcodes);
		const exceptional = new CoreFunctionBuilder(exceptionalProgram, {
			parameterCount: 1,
		});
		const defining = exceptional.createBlock([{ representation: "boxed" }]);
		const recovery = exceptional.createBlock([{ role: "exception" }]);
		const protectedBlock = exceptional.createBlock();
		const protectedHandler = exceptional.createBlock([
			{ role: "exception" },
			{ representation: "boxed" },
		]);
		const exceptionalInput = inspectCoreBlockParameters(exceptional, defining)[0]!.value;
		const [exceptionalLate] = exceptional.appendInstruction(defining, "call", [
			exceptionalInput,
		]);
		exceptional.setHandler(defining, recovery);
		exceptional.setTerminator(defining, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		exceptional.setTerminator(recovery, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		exceptional.appendInstruction(protectedBlock, "call", [exceptionalInput]);
		exceptional.setHandler(protectedBlock, protectedHandler, [exceptionalLate!]);
		exceptional.setTerminator(protectedBlock, {
			kind: "return",
			value: exceptionalInput,
		});
		exceptional.setTerminator(protectedHandler, {
			kind: "return",
			value: inspectCoreBlockParameters(exceptional, protectedHandler)[1]!.value,
		});
		const { function: exceptionalFunction } = exceptional.finish(defining);
		expect(() => verifyCoreFunction(exceptionalProgram, exceptionalFunction)).toThrow(
			/unavailable on b2's exception edge/,
		);
	});

	it("requires guarded provenance before asserted facts refine effects", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const fact = builder.addFact({
			kind: "typescript-type",
			value: "number",
			claims: [],
			validity: { kind: "asserted", source: "fixture.ts" },
			obligations: [],
			origin: "test",
		});
		const [result] = builder.appendInstruction(
			entry,
			"call",
			[inspectCoreBlockParameters(builder, entry)[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const { function: functionId } = builder.finish(entry);

		expect(() => verifyCoreFunction(program, functionId)).toThrow(
			/asserted fact .* without a guard/,
		);
	});

	it("allows a runtime guard to establish a fact on only its success edge", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const fast = builder.createBlock([{ representation: "boxed" }]);
		const fallback = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: fast, arguments: [input!] },
			fallback: { block: fallback, arguments: [input!] },
			fact: {
				kind: "exact-call-target",
				value: 7,
				claims: [],
				origin: "test",
				obligations: [{ kind: "fallback", id: "generic-call" }],
			},
		});
		const [result] = builder.appendInstruction(
			fast,
			"call",
			[inspectCoreBlockParameters(builder, fast)[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(fast, { kind: "return", value: result! });
		builder.setTerminator(fallback, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, fallback)[0]!.value,
		});

		const { function: functionId } = builder.finish(entry);
		expect(() => verifyCoreFunction(program, functionId)).not.toThrow();
		expect(formatCoreFunction(program, functionId)).toContain("guard %0 proves !0");
	});

	it("rejects a guarded fact after its success and fallback paths merge", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const success = builder.createBlock([{ representation: "boxed" }]);
		const merge = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: success, arguments: [input!] },
			fallback: { block: merge, arguments: [input!] },
			fact: { kind: "exact-call-target", value: 7, claims: [], origin: "test" },
		});
		builder.setTerminator(success, {
			kind: "jump",
			edge: {
				block: merge,
				arguments: [inspectCoreBlockParameters(builder, success)[0]!.value],
			},
		});
		const [result] = builder.appendInstruction(
			merge,
			"call",
			[inspectCoreBlockParameters(builder, merge)[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(merge, { kind: "return", value: result! });
		const { function: functionId } = builder.finish(entry);

		expect(() => verifyCoreFunction(program, functionId)).toThrow(/does not dominate/);
	});

	it("rejects a guarded fact in a block another predecessor also enters", () => {
		const opcodes = registry();
		const program = new CoreProgram(opcodes);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const guarded = builder.createBlock();
		const bypass = builder.createBlock();
		const join = builder.createBlock();
		const fallback = builder.createBlock();
		const [selector, condition, input] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: selector!,
			consequent: { block: guarded, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		const fact = builder.setGuardTerminator(guarded, {
			condition: condition!,
			success: { block: join, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: { kind: "exact-call-target", value: 7, claims: [], origin: "test" },
		});
		builder.setTerminator(bypass, { kind: "jump", edge: { block: join, arguments: [] } });
		const [result] = builder.appendInstruction(join, "call", [input!], {
			effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact },
		});
		builder.setTerminator(join, { kind: "return", value: result! });
		builder.setTerminator(fallback, { kind: "return", value: input! });
		const { function: functionId } = builder.finish(entry);

		expect(() => verifyCoreFunction(program, functionId)).toThrow(/does not dominate/);
	});

	it("rejects a range claim no value satisfies", () => {
		const opcodes = registry();
		const build = (
			claim: CoreFactClaim,
		): { readonly program: CoreProgram; readonly function: CoreFunctionId } => {
			const program = new CoreProgram(opcodes);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const value = inspectCoreBlockParameters(builder, entry)[0]!.value;
			builder.addFact({
				kind: "numeric-range",
				value: null,
				claims: [claim],
				validity: { kind: "summary", digest: "range-test" },
				obligations: [],
				origin: "test",
			});
			builder.setTerminator(entry, { kind: "return", value });
			const { function: functionId } = builder.finish(entry);
			return { program, function: functionId };
		};
		const verify = (claim: CoreFactClaim): void => {
			const built = build(claim);
			verifyCoreFunction(built.program, built.function);
		};
		const subject = coreValueId(0);
		const range = (
			bounds: Partial<
				Omit<Extract<CoreFactClaim, { kind: "range" }>, "kind" | "subject">
			>,
		): CoreFactClaim => ({
			kind: "range",
			subject,
			minimum: null,
			maximum: null,
			integer: false,
			mayBeNaN: false,
			mayBeNegativeZero: false,
			...bounds,
		});

		expect(() => verify(range({ minimum: 5, maximum: 4 }))).toThrow(
			/invalid numeric interval/,
		);
		expect(() => verify(range({ minimum: 0.2, maximum: 0.8, integer: true }))).toThrow(
			/invalid numeric interval/,
		);
		expect(() => verify(range({ minimum: Number.NaN }))).toThrow(
			/invalid numeric interval/,
		);
		// An empty interval still denotes NaN when the claim admits it.
		expect(() => verify(range({ minimum: 5, maximum: 4, mayBeNaN: true }))).not.toThrow();
	});
});
