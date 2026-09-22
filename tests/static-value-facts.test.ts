import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	StaticDescriptionInterner,
	staticNumberDescription,
} from "../src/compiler/shared/static-values.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

describe("static descriptions and allocation identities", () => {
	it("skips mutable contents for a constant query and observes later property mutations on demand", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[120]] });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock(),
			after = builder.createBlock();
		const [initial] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [0] },
		});
		const [updated] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 9 },
		});
		builder.appendInstruction(entry, "storePropertyStatic", [object!, updated!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "jump", edge: { block: after, arguments: [] } });
		builder.setTerminator(after, { kind: "return", value: object! });
		const fn = program.function(builder.finish(entry).function);
		let controlQueries = 0;
		const facts = new CoreStaticValueAnalysis(program, fn, () => {
			controlQueries++;
			return buildCoreControlFlow(program, fn.id);
		});
		const consumer = fn.blockTerminator(after);
		expect(facts.constant(object!, consumer)).toBeUndefined();
		expect(controlQueries).toBe(0);
		const observed = facts.queryAt(object!, consumer);
		if (observed.kind !== "known") throw new Error("Expected observed object");
		const description = program.staticDescriptions.description(observed.description);
		if (description.kind !== "object") throw new Error("Expected object description");
		const property = description.properties[0];
		if (
			property?.descriptor.kind !== "data" ||
			property.descriptor.value.kind !== "constant"
		)
			throw new Error("Expected constant data property");
		expect(facts.descriptionConstant(property.descriptor.value.description)).toEqual({
			kind: "number",
			value: 9,
		});
		expect(controlQueries).toBeGreaterThan(0);
	});

	it.each(["typeof", "tostring", "void"])(
		"does not spend constant-query budget on an unused %s operand",
		(operator) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [result] = builder.appendInstruction(entry, "unary", [value!], {
				attributes: { operator },
			});
			builder.setTerminator(entry, { kind: "return", value: result! });
			const fn = program.function(builder.finish(entry).function);
			const facts = new CoreStaticValueAnalysis(
				program,
				fn,
				() => buildCoreControlFlow(program, fn.id),
				2,
			);
			facts.query(result!);
			expect(facts.statistics.visits).toBe(1);
			expect(facts.constant(value!)).toEqual({ kind: "number", value: 7 });
			expect(facts.statistics.budgetBailouts).toBe(0);
		},
	);

	it("still infers a string addition result when its first operand is unknown", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[120]] });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [string] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [result] = builder.appendInstruction(entry, "binary", [parameter, string!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = program.function(builder.finish(entry).function);
		const facts = new CoreStaticValueAnalysis(program, fn, () =>
			buildCoreControlFlow(program, fn.id),
		);
		expect(facts.query(result!)).toMatchObject({ kind: "known", brand: "string" });
		expect(facts.constant(result!)).toBeUndefined();
	});

	it.each(["Global", "Local", "Captured"] as const)(
		"does not build memory versions for an unwritten %s slot",
		(family) => {
			const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [stored] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			builder.appendInstruction(entry, `store${family}`, [stored!], {
				attributes: family === "Captured" ? { functionIndex: 1, index: 0 } : { index: 1 },
			});
			const [loaded] = builder.appendInstruction(entry, `load${family}`, [], {
				attributes: family === "Captured" ? { functionIndex: 0, index: 0 } : { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			const fn = program.function(builder.finish(entry).function);
			const facts = new CoreStaticValueAnalysis(
				program,
				fn,
				() => buildCoreControlFlow(program, fn.id),
				undefined,
				undefined,
				() => {
					throw new Error("Unwritten slot requested memory versions");
				},
			);
			expect(facts.query(loaded!).kind).toBe("unknown");
		},
	);

	it("interns equal recipes without equating separately evaluated objects or aliases", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [first] = builder.appendInstruction(entry, "createObject", []);
		const [second] = builder.appendInstruction(entry, "createObject", []);
		const [alias] = builder.appendInstruction(entry, "move", [first!]);
		builder.setTerminator(entry, { kind: "return", value: alias! });
		const fn = program.function(builder.finish(entry).function);
		const facts = new CoreStaticValueAnalysis(program, fn, () =>
			buildCoreControlFlow(program, fn.id),
		);
		const a = facts.query(first!),
			b = facts.query(second!),
			same = facts.query(alias!);
		if (a.kind !== "known" || b.kind !== "known" || same.kind !== "known")
			throw new Error("Expected initial allocation facts");
		expect(a.description).toBe(b.description);
		expect(a.identity).not.toEqual(b.identity);
		expect(same.identity).toEqual(a.identity);
		expect(same.identity?.kind).toBe("fresh-per-evaluation");
		facts.verify(same);
	});

	it.each([undefined, "+", "!", "typeof"])(
		"keeps dynamic %s leaves in SSA and rejects facts after an editor mutation",
		(operator) => {
			const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[120]] });
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const input =
				operator === undefined
					? parameter
					: builder.appendInstruction(entry, "unary", [parameter], {
							attributes: { operator },
						})[0]!;
			const [object] = builder.appendInstruction(entry, "createObjectShaped", [input], {
				attributes: { keyStringIndices: [0] },
			});
			builder.setTerminator(entry, { kind: "return", value: object! });
			const fn = program.function(builder.finish(entry).function);
			const facts = new CoreStaticValueAnalysis(program, fn, () =>
				buildCoreControlFlow(program, fn.id),
			);
			const fact = facts.query(object!);
			if (fact.kind !== "known") throw new Error("Expected known shape");
			expect(program.staticDescriptions.summary(fact.description).constantContents).toBe(
				false,
			);
			expect(fact.operands).toEqual([input]);
			expect(fn.valueUseCount(input)).toBe(1);
			facts.verify(fact, fn.blockTerminator(entry));
			const editor = CoreEditor.open(program, fn.id);
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(object!));
			editor.replaceInstruction(instruction, "createObject", [], {});
			editor.commit();
			expect(() => facts.verify(fact)).toThrow("Stale static-value facts");
		},
	);

	it("distinguishes holes, undefined, signed zero, and metadata with dynamic operands", () => {
		const descriptions = new StaticDescriptionInterner();
		const undef = descriptions.intern({ kind: "undefined" });
		const prototype = { kind: "intrinsic", id: "Array.prototype" } as const;
		const hole = descriptions.intern({
			kind: "array",
			prototype,
			length: 1,
			properties: [],
		});
		const value = descriptions.intern({
			kind: "array",
			prototype,
			length: 1,
			properties: [
				{
					key: "0",
					enumerable: true,
					configurable: true,
					descriptor: {
						kind: "data",
						writable: true,
						value: { kind: "constant", description: undef },
					},
				},
			],
		});
		expect(hole).not.toBe(value);
		expect(descriptions.intern(staticNumberDescription(-0))).not.toBe(
			descriptions.intern(staticNumberDescription(0)),
		);
		expect(descriptions.intern(staticNumberDescription(NaN))).toBe(
			descriptions.intern(staticNumberDescription(NaN)),
		);
		const dynamic = descriptions.intern({
			kind: "array",
			prototype,
			length: 1,
			properties: [
				{
					key: "0",
					enumerable: true,
					configurable: true,
					descriptor: {
						kind: "data",
						writable: true,
						value: { kind: "operand", index: 0 },
					},
				},
			],
		});
		expect(descriptions.summary(dynamic)).toMatchObject({
			constantContents: false,
			operandSlots: [0],
		});
	});

	it("requires identity bindings for object and symbol members", () => {
		const descriptions = new StaticDescriptionInterner();
		const symbol = descriptions.intern({ kind: "symbol", description: "x" });
		const prototype = { kind: "intrinsic", id: "Array.prototype" } as const;
		expect(() =>
			descriptions.intern({
				kind: "array",
				prototype,
				length: 1,
				properties: [
					{
						key: "0",
						enumerable: true,
						configurable: true,
						descriptor: {
							kind: "data",
							writable: true,
							value: { kind: "constant", description: symbol },
						},
					},
				],
			}),
		).toThrow("require allocation bindings");
		const pair = descriptions.intern({
			kind: "array",
			prototype,
			length: 2,
			properties: [0, 1].map((index) => ({
				key: String(index),
				enumerable: true,
				configurable: true,
				descriptor: {
					kind: "data",
					writable: true,
					value: { kind: "allocation", description: symbol, identitySlot: index },
				},
			})),
		});
		expect(descriptions.summary(pair)).toMatchObject({
			constantContents: true,
			identitySlots: [0, 1],
		});
	});
	it("joins equal shape descriptions at a diamond without inventing an allocation identity", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const left = builder.createBlock(),
			right = builder.createBlock(),
			merge = builder.createBlock([{ representation: "boxed" }]);
		const joined = inspectCoreBlockParameters(builder, merge)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const block of [left, right]) {
			const [object] = builder.appendInstruction(block, "createObject", []);
			builder.setTerminator(block, {
				kind: "jump",
				edge: { block: merge, arguments: [object!] },
			});
		}
		builder.setTerminator(merge, { kind: "return", value: joined });
		const fn = program.function(builder.finish(entry).function);
		const analysis = new CoreStaticValueAnalysis(program, fn, () =>
			buildCoreControlFlow(program, fn.id),
		);
		expect(analysis.query(joined)).toMatchObject({
			kind: "known",
			brand: "object",
			state: "joined-allocation",
			identity: undefined,
		});
	});

	it("widens cyclic SSA and bounds work across thousands of requested values", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock(),
			loop = builder.createBlock([{ representation: "boxed" }]);
		const phi = inspectCoreBlockParameters(builder, loop)[0]!.value;
		const values = Array.from(
			{ length: 2000 },
			(_, value) =>
				builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value },
				})[0]!,
		);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: loop, arguments: [values[0]!] },
		});
		builder.setTerminator(loop, {
			kind: "jump",
			edge: { block: loop, arguments: [phi] },
		});
		const fn = program.function(builder.finish(entry).function);
		const analysis = new CoreStaticValueAnalysis(
			program,
			fn,
			() => buildCoreControlFlow(program, fn.id),
			512,
		);
		expect(analysis.query(phi)).toMatchObject({
			kind: "unknown",
			reason: "cycle-widening",
		});
		for (const value of values) analysis.query(value);
		expect(analysis.statistics.visits).toBe(512);
		expect(analysis.statistics.budgetBailouts).toBeGreaterThan(0);
		const before = analysis.statistics.visits;
		analysis.query(values[0]!);
		expect(analysis.statistics.visits).toBe(before);
	});
});
