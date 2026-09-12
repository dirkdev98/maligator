import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import type { StaticMember } from "../src/compiler/shared/static-values.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function fixture(length: number, locked = true) {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [array] = builder.appendInstruction(entry, "createArray", [], {
		attributes: { length },
	});
	const number = (value: number) =>
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value },
		})[0]!;
	const undefinedValue = () =>
		builder.appendInstruction(entry, "createUndefined", [])[0]!;
	const primitive = (value: boolean | number | string | bigint | null | undefined) => {
		if (value === undefined) return undefinedValue();
		if (value === null) return builder.appendInstruction(entry, "createNull", [])[0]!;
		if (typeof value === "number") return number(value);
		if (typeof value === "boolean")
			return builder.appendInstruction(entry, "createBoolean", [], {
				attributes: { value },
			})[0]!;
		if (typeof value === "bigint")
			return builder.appendInstruction(entry, "createBigint", [], {
				attributes: { bigintIndex: builder.editor.appendBigintConstants([value]) },
			})[0]!;
		return builder.appendInstruction(entry, "createString", [], {
			attributes: {
				stringIndex: builder.editor.appendStringConstants([
					Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
				]),
			},
		})[0]!;
	};
	const getter = () => {
		const body = new CoreFunctionBuilder(program);
		const block = body.createBlock();
		const [result] = body.appendInstruction(block, "createUndefined", []);
		body.setTerminator(block, { kind: "return", value: result! });
		const functionIndex = body.finish(block).function;
		return builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex },
		})[0]!;
	};
	const setOn = (
		target: CoreValueId,
		index: number,
		value: CoreValueId,
		accessor = false,
	) => {
		builder.appendInstruction(
			entry,
			accessor ? "defineAccessor" : "defineProperty",
			[target, number(index), value],
			{
				attributes: { enumerable: true, ...(accessor ? { kind: "get" } : {}) },
			},
		);
	};
	const set = (index: number, value: CoreValueId, accessor = false) =>
		setOn(array!, index, value, accessor);
	const nestedArray = (
		length: number,
		entries: ReadonlyArray<readonly [number, CoreValueId]>,
	) => {
		const [child] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length },
		});
		for (const [index, value] of entries) setOn(child!, index, value);
		return child!;
	};
	const copy = (method: string, args: ReadonlyArray<CoreValueId> = []) =>
		builder.appendInstruction(entry, "callKnown", [array!, ...args], {
			attributes: { operation: `Array.prototype.${method}` },
		})[0]!;
	const finish = (result: CoreValueId) => {
		builder.setTerminator(entry, { kind: "return", value: result });
		const fn = program.function(builder.finish(entry).function);
		const analysis = new CoreStaticValueAnalysis(
			program,
			fn,
			() => buildCoreControlFlow(program, fn.id),
			65536,
			{
				...programAnalysisContext(),
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({
						engine: { primordials: locked ? "locked" : "mutable" },
					}),
				),
			},
		);
		const fact = analysis.query(result);
		const member = (value: StaticMember): unknown => {
			if (value.kind === "operand")
				return {
					operand: fact.kind === "known" ? fact.operands[value.index] : undefined,
				};
			if (value.kind !== "constant") return value;
			const constant = analysis.descriptionConstant(value.description);
			return constant?.kind === "undefined" ? undefined : constant?.value;
		};
		const description =
			fact.kind === "known"
				? program.staticDescriptions.description(fact.description)
				: undefined;
		return {
			analysis,
			fact,
			description,
			elements:
				description?.kind === "array"
					? description.properties.map((property) =>
							property.descriptor.kind === "data"
								? member(property.descriptor.value)
								: "accessor",
						)
					: undefined,
		};
	};
	return {
		program,
		builder,
		entry,
		array: array!,
		number,
		undefinedValue,
		primitive,
		getter,
		set,
		setOn,
		nestedArray,
		copy,
		finish,
	};
}

describe("static array copy descriptions", () => {
	it("reverses primitive contents and turns proved holes into own undefined elements", () => {
		const f = fixture(3);
		f.set(0, f.number(1));
		f.set(2, f.number(3));
		const result = f.copy("toReversed");
		const inspected = f.finish(result);
		expect(inspected.elements).toEqual([3, undefined, 1]);
		expect(inspected.description).toMatchObject({
			length: 3,
			ownKeysComplete: true,
		});
		expect(inspected.fact).toMatchObject({
			identity: { kind: "fresh-per-evaluation", value: result },
		});
	});

	it("retains nested object aliases while assigning the copy a separate identity", () => {
		const f = fixture(2);
		const [child] = f.builder.appendInstruction(f.entry, "createObject", []);
		f.set(0, child!);
		f.set(1, child!);
		const result = f.copy("toReversed");
		const inspected = f.finish(result);
		expect(inspected.elements).toEqual([{ operand: child }, { operand: child }]);
		const source = inspected.analysis.query(f.array);
		expect(source.kind === "known" && source.identity).not.toEqual(
			inspected.fact.kind === "known" && inspected.fact.identity,
		);
	});

	it("with skips the replaced getter and uses truncated negative indexes", () => {
		const f = fixture(3);
		f.set(2, f.getter(), true);
		const replacement = f.number(9);
		const result = f.copy("with", [f.number(-1.8), replacement]);
		expect(f.finish(result).elements).toEqual([undefined, undefined, 9]);
	});

	it.each([-4, 3, Infinity, -Infinity])("retains the throwing with index %s", (index) => {
		const f = fixture(3);
		expect(f.finish(f.copy("with", [f.number(index), f.number(9)])).fact.kind).toBe(
			"unknown",
		);
	});

	it("with without a replacement stores an explicit undefined", () => {
		const f = fixture(1);
		f.set(0, f.number(5));
		expect(f.finish(f.copy("with")).elements).toEqual([undefined]);
	});

	it.each([
		[true, [1, 9, 3]],
		[false, [9, 2, 3]],
		[null, [9, 2, 3]],
		[" -1.8 ", [1, 2, 9]],
		["-0", [9, 2, 3]],
		[-0, [9, 2, 3]],
		["0x1", [1, 9, 3]],
		["not-a-number", [9, 2, 3]],
	] as const)("with converts primitive index %s", (bound, expected) => {
		const f = fixture(3);
		for (let index = 0; index < 3; index++) f.set(index, f.number(index + 1));
		expect(f.finish(f.copy("with", [f.primitive(bound), f.number(9)])).elements).toEqual(
			expected,
		);
	});

	it("toSpliced distinguishes omitted delete count from explicit undefined", () => {
		for (const explicit of [false, true]) {
			const f = fixture(3);
			for (let index = 0; index < 3; index++) f.set(index, f.number(index + 1));
			const args = [f.number(1), ...(explicit ? [f.undefinedValue()] : [])];
			expect(f.finish(f.copy("toSpliced", args)).elements).toEqual(
				explicit ? [1, 2, 3] : [1],
			);
		}
	});

	it("toSpliced skips removed getters and retains inserted object identity", () => {
		const f = fixture(3);
		const [child] = f.builder.appendInstruction(f.entry, "createObject", []);
		f.set(1, f.getter(), true);
		const result = f.copy("toSpliced", [f.number(1), f.number(1), child!]);
		expect(f.finish(result).elements).toEqual([undefined, { operand: child }, undefined]);
	});

	it.each([
		[true, "1", [1, 9, 3]],
		[null, false, [9, 1, 2, 3]],
		["-1.8", "Infinity", [1, 2, 9]],
		["-Infinity", 0, [9, 1, 2, 3]],
		["Infinity", 1, [1, 2, 3, 9]],
		["-0", "-Infinity", [9, 1, 2, 3]],
		[undefined, undefined, [9, 1, 2, 3]],
	] as const)(
		"toSpliced converts primitive bounds %s and %s",
		(start, count, expected) => {
			const f = fixture(3);
			for (let index = 0; index < 3; index++) f.set(index, f.number(index + 1));
			const result = f.copy("toSpliced", [
				f.primitive(start),
				f.primitive(count),
				f.number(9),
			]);
			expect(f.finish(result).elements).toEqual(expected);
		},
	);

	it("slice preserves absent indexes and child aliases in a fresh result", () => {
		const f = fixture(4);
		const [child] = f.builder.appendInstruction(f.entry, "createObject", []);
		f.set(1, child!);
		f.set(3, child!);
		const result = f.copy("slice", [f.number(1), f.undefinedValue()]);
		const inspected = f.finish(result);
		expect(inspected.elements).toEqual([{ operand: child }, { operand: child }]);
		expect(inspected.description).toMatchObject({
			length: 3,
			properties: [{ key: "0" }, { key: "2" }],
		});
		expect(inspected.fact).toMatchObject({
			identity: { kind: "fresh-per-evaluation", value: result },
		});
	});

	it("concat preserves holes and remaps shallow aliases from distinct array segments", () => {
		const f = fixture(2);
		const [first] = f.builder.appendInstruction(f.entry, "createObject", []);
		const [second] = f.builder.appendInstruction(f.entry, "createObject", []);
		f.set(0, first!);
		const [other] = f.builder.appendInstruction(f.entry, "createArray", [], {
			attributes: { length: 3 },
		});
		for (const [index, input] of [
			[0, second!],
			[2, first!],
		] as const)
			f.builder.appendInstruction(
				f.entry,
				"defineProperty",
				[other!, f.number(index), input],
				{
					attributes: { enumerable: true },
				},
			);
		const result = f.copy("concat", [other!, f.primitive("ab"), f.primitive(null)]);
		const inspected = f.finish(result);
		expect(inspected.elements).toEqual([
			{ operand: first },
			{ operand: second },
			{ operand: first },
			"ab",
			null,
		]);
		expect(inspected.description).toMatchObject({
			length: 7,
			properties: [{ key: "0" }, { key: "2" }, { key: "4" }, { key: "5" }, { key: "6" }],
		});
		expect(inspected.fact).toMatchObject({
			identity: { kind: "fresh-per-evaluation", value: result },
		});
	});

	it("concat appends an ordinary non-array object without cloning it", () => {
		const f = fixture(0);
		const [child] = f.builder.appendInstruction(f.entry, "createObject", []);
		const inspected = f.finish(f.copy("concat", [child!, child!]));
		expect(inspected.elements).toEqual([{ operand: child }, { operand: child }]);
	});

	it.each([false, true, undefined])(
		"retains concat when the receiver has its own spreadability value %s",
		(spreadable) => {
			const f = fixture(1);
			const [key] = f.builder.appendInstruction(f.entry, "loadIntrinsic", [], {
				attributes: { intrinsic: "%Symbol.isConcatSpreadable%" },
			});
			f.builder.appendInstruction(
				f.entry,
				"defineProperty",
				[f.array, key!, f.primitive(spreadable)],
				{
					attributes: { enumerable: true },
				},
			);
			expect(f.finish(f.copy("concat")).fact.kind).toBe("unknown");
		},
	);

	it("bounds concat expansion across multiple segments", () => {
		const f = fixture(256);
		expect(f.finish(f.copy("concat", [f.number(1)])).fact.kind).toBe("unknown");
	});

	it("bounds repeated concat descriptor scans even when segments are empty", () => {
		const f = fixture(0);
		for (let index = 0; index < 64; index++)
			f.builder.appendInstruction(
				f.entry,
				"defineProperty",
				[f.array, f.primitive(`named${index}`), f.number(index)],
				{ attributes: { enumerable: true } },
			);
		expect(
			f.finish(
				f.copy(
					"concat",
					Array.from({ length: 64 }, () => f.array),
				),
			).fact.kind,
		).toBe("unknown");
	});

	it.each([0, -0.9, -1, -Infinity, NaN, null, false, "invalid", "-1"] as const)(
		"flat with shallow depth %s removes holes and preserves nested array identity",
		(depth) => {
			const f = fixture(4);
			const [child] = f.builder.appendInstruction(f.entry, "createArray", [], {
				attributes: { length: 1 },
			});
			f.set(0, child!);
			f.set(2, f.undefinedValue());
			f.set(3, f.number(7));
			const result = f.copy("flat", [f.primitive(depth)]);
			const inspected = f.finish(result);
			expect(inspected.elements).toEqual([{ operand: child }, undefined, 7]);
			expect(inspected.description).toMatchObject({ length: 3 });
			expect(inspected.fact).toMatchObject({
				identity: { kind: "fresh-per-evaluation", value: result },
			});
		},
	);

	it.each([undefined, 1, 1.9, true, "1"] as const)(
		"flat depth %s flattens one level and retains deeper array identities",
		(depth) => {
			const f = fixture(4);
			const leaf = f.nestedArray(3, [[1, f.number(7)]]);
			const child = f.nestedArray(4, [
				[1, leaf],
				[2, f.number(8)],
			]);
			f.set(1, child);
			f.set(3, f.number(9));
			const result = f.copy("flat", [f.primitive(depth)]);
			const inspected = f.finish(result);
			expect(inspected.elements).toEqual([{ operand: leaf }, 8, 9]);
			expect(inspected.description).toMatchObject({ length: 3 });
			expect(inspected.fact).toMatchObject({
				identity: { kind: "fresh-per-evaluation", value: result },
			});
		},
	);

	it.each([2, "2", 20, Infinity] as const)(
		"flat depth %s removes holes at each visited array level",
		(depth) => {
			const f = fixture(3);
			const leaf = f.nestedArray(3, [[1, f.number(7)]]);
			const child = f.nestedArray(4, [
				[1, leaf],
				[2, f.number(8)],
			]);
			f.set(0, child);
			f.set(2, f.number(9));
			expect(f.finish(f.copy("flat", [f.primitive(depth)])).elements).toEqual([7, 8, 9]);
		},
	);

	it("flat uses one level when depth is omitted", () => {
		const f = fixture(2);
		f.set(1, f.nestedArray(2, [[0, f.number(7)]]));
		expect(f.finish(f.copy("flat")).elements).toEqual([7]);
	});

	it("flat rereads shared child contents at the original call and visits repeated aliases", () => {
		const f = fixture(2);
		const child = f.nestedArray(1, [[0, f.number(1)]]);
		f.set(0, child);
		f.set(1, child);
		f.setOn(child, 0, f.number(9));
		expect(f.finish(f.copy("flat")).elements).toEqual([9, 9]);
	});

	it("flat retains ordinary object and function identities at positive depth", () => {
		const f = fixture(2);
		const [object] = f.builder.appendInstruction(f.entry, "createObject", []);
		const callable = f.getter();
		f.set(0, object!);
		f.set(1, callable);
		expect(f.finish(f.copy("flat")).elements).toEqual([
			{ operand: object },
			{ operand: callable },
		]);
	});

	it.each([1, 2])(
		"flat classifies dynamic child values only with remaining depth %s",
		(depth) => {
			const f = fixture(1);
			const dynamic = f.builder.appendBlockParameter(f.entry);
			f.set(0, f.nestedArray(1, [[0, dynamic]]));
			const inspected = f.finish(f.copy("flat", [f.number(depth)]));
			if (depth === 1) expect(inspected.elements).toEqual([{ operand: dynamic }]);
			else expect(inspected.fact.kind).toBe("unknown");
		},
	);

	it("flat ignores nested constructor getters when choosing the root species", () => {
		const f = fixture(1);
		const child = f.nestedArray(1, [[0, f.number(7)]]);
		f.builder.appendInstruction(
			f.entry,
			"defineAccessor",
			[child, f.primitive("constructor"), f.getter()],
			{
				attributes: { enumerable: true, kind: "get" },
			},
		);
		f.set(0, child);
		expect(f.finish(f.copy("flat")).elements).toEqual([7]);
	});

	it("flat ignores nested concat spreadability getters", () => {
		const f = fixture(1);
		const child = f.nestedArray(1, [[0, f.number(7)]]);
		const [key] = f.builder.appendInstruction(f.entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "%Symbol.isConcatSpreadable%" },
		});
		f.builder.appendInstruction(f.entry, "defineAccessor", [child, key!, f.getter()], {
			attributes: { enumerable: true, kind: "get" },
		});
		f.set(0, child);
		expect(f.finish(f.copy("flat")).elements).toEqual([7]);
	});

	it("retains nested recipe allocations without independent child observations", () => {
		const f = fixture(1);
		const template = f.builder.editor.appendLiteralTemplate([8, 1, 8, 1, 3, 7], false);
		const [child] = f.builder.appendInstruction(
			f.entry,
			"instantiateLiteralTemplate",
			[],
			{
				attributes: template,
			},
		);
		f.set(0, child!);
		expect(f.finish(f.copy("flat")).fact.kind).toBe("unknown");
	});

	it("flat retains BigInt depth coercion", () => {
		const f = fixture(0);
		expect(f.finish(f.copy("flat", [f.primitive(0n)])).fact.kind).toBe("unknown");
	});

	it.each([1, Infinity])("retains recursive array cycles at flat depth %s", (depth) => {
		const f = fixture(1);
		f.set(0, f.array);
		expect(f.finish(f.copy("flat", [f.number(depth)])).fact.kind).toBe("unknown");
	});

	it("bounds flat output across repeated child arrays", () => {
		const f = fixture(2);
		const child = f.nestedArray(
			130,
			Array.from({ length: 130 }, (_, index) => [index, f.number(index)] as const),
		);
		f.set(0, child);
		f.set(1, child);
		expect(f.finish(f.copy("flat")).fact.kind).toBe("unknown");
	});

	it("bounds flat traversal through empty arrays with many named descriptors", () => {
		const f = fixture(64);
		const child = f.nestedArray(0, []);
		for (let index = 0; index < 64; index++) {
			f.builder.appendInstruction(
				f.entry,
				"defineProperty",
				[child, f.primitive(`named${index}`), f.number(index)],
				{
					attributes: { enumerable: true },
				},
			);
			f.set(index, child);
		}
		expect(f.finish(f.copy("flat", [f.number(Infinity)])).fact.kind).toBe("unknown");
	});

	it("bounds recursive flat depth independently of output size", () => {
		const f = fixture(1);
		let child = f.nestedArray(0, []);
		for (let level = 0; level < 34; level++) child = f.nestedArray(1, [[0, child]]);
		f.set(0, child);
		expect(f.finish(f.copy("flat", [f.number(Infinity)])).fact.kind).toBe("unknown");
	});

	it("retains getters in recursively visited child arrays", () => {
		const f = fixture(1);
		const child = f.nestedArray(1, []);
		f.setOn(child, 0, f.getter(), true);
		f.set(0, child);
		expect(f.finish(f.copy("flat")).fact.kind).toBe("unknown");
	});

	it.each(["other", "new Proxy([2], {})"])(
		"retains flat when child array identity is unknown for %s",
		(child) => {
			const output = inspectStaticValueFunction(
				`function target(other) { return [${child}].flat(); } globalThis.target=target;`,
				"target",
			);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === "Array.prototype.flat",
				),
			).toBe(true);
		},
	);

	it.each([0, 1, Infinity])("retains root flat species lookup at depth %s", (depth) => {
		const output = inspectStaticValueFunction(
			`function target(constructor) { const a=[1,,2]; a.constructor=constructor; return a.flat(${depth}); } globalThis.target=target;`,
			"target",
		);
		expect(output.structure.genericLookups).toBeGreaterThan(0);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});

	it.each([
		"other",
		"new Proxy([2], {})",
		"{ [Symbol.isConcatSpreadable]: true, length: 1, 0: 2 }",
		"{ get [Symbol.isConcatSpreadable]() { return false; } }",
	])("retains observable or unknown concat protocol for %s", (argument) => {
		const inspected = inspectStaticValueFunction(
			`function target(other) { return [1].concat(${argument}); } globalThis.target=target;`,
			"target",
		);
		expect(
			inspected.core.some(
				(operation) => operation.attributes.operation === "Array.prototype.concat",
			),
		).toBe(true);
	});

	it.each([
		[-2.8, Infinity, [2, 3]],
		[-Infinity, -1.2, [1, 2]],
		[NaN, 1, [1]],
		[2, 1, []],
	] as const)("slice clamps numeric bounds %s and %s", (start, end, expected) => {
		const f = fixture(3);
		for (let index = 0; index < 3; index++) f.set(index, f.number(index + 1));
		expect(f.finish(f.copy("slice", [f.number(start), f.number(end)])).elements).toEqual(
			expected,
		);
	});

	it("slice skips getters outside the copied range", () => {
		const f = fixture(2);
		f.set(0, f.getter(), true);
		f.set(1, f.number(7));
		expect(f.finish(f.copy("slice", [f.number(1)])).elements).toEqual([7]);
	});

	it.each([
		[true, undefined, [2, 3]],
		[false, true, [1]],
		[null, "2", [1, 2]],
		[" -2.8 ", "Infinity", [2, 3]],
		["-Infinity", "-1.2", [1, 2]],
		["-0", "1", [1]],
		["not-a-number", 1, [1]],
		["0x1", "0b11", [2, 3]],
	] as const)("slice converts primitive bounds %s and %s", (start, end, expected) => {
		const f = fixture(3);
		for (let index = 0; index < 3; index++) f.set(index, f.number(index + 1));
		const result = f.copy("slice", [f.primitive(start), f.primitive(end)]);
		expect(f.finish(result).elements).toEqual(expected);
	});

	it.each([
		["with", [1n, 9]],
		["slice", [1n]],
		["slice", [0, 1n]],
		["toSpliced", [1n]],
		["toSpliced", [0, 1n]],
	] as const)("retains throwing BigInt bounds in %s(%s)", (method, args) => {
		const f = fixture(3);
		const result = f.copy(method, args.map(f.primitive));
		expect(f.finish(result).fact.kind).toBe("unknown");
	});

	it.each(["slice", "with", "toSpliced"])(
		"retains %s when bounds require object coercion",
		(method) => {
			const f = fixture(3);
			const [bound] = f.builder.appendInstruction(f.entry, "createObject", []);
			expect(f.finish(f.copy(method, [bound!])).fact.kind).toBe("unknown");
		},
	);

	it.each(["slice", "concat"])(
		"retains %s when an own constructor can select custom species",
		(method) => {
			const output = inspectStaticValueFunction(
				`function target(constructor) { const source = [1,2,3]; source.constructor = constructor; return source.${method}(1); } globalThis.target = target;`,
				"target",
			);
			expect(output.structure.genericLookups).toBeGreaterThan(0);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
		},
	);

	it("materializes sparse slice with only its present dynamic elements", () => {
		const output = inspectStaticValueFunction(
			"function target(x) { return [x,,x].slice(); } globalThis.target = target;",
			"target",
		);
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === "Array.prototype.slice",
			),
		).toBe(false);
		expect(output.structure.allocations).toBe(1);
	});

	it("materializes an all-hole slice with its full length and no own elements", () => {
		const output = inspectStaticValueFunction(
			"function target() { return [,,,].slice(); } globalThis.target = target;",
			"target",
		);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
		expect(output.structure.allocations).toBe(1);
	});

	it.each(["toReversed", "with", "toSpliced", "slice", "concat", "flat"])(
		"retains observable reads in %s",
		(method) => {
			const f = fixture(3);
			f.set(2, f.getter(), true);
			const result = f.copy(
				method,
				method === "with" || method === "flat" ? [f.number(0)] : [],
			);
			expect(f.finish(result).fact.kind).toBe("unknown");
		},
	);

	it("leaves mutable-world copies undiscovered", () => {
		const f = fixture(1, false);
		f.set(0, f.number(1));
		expect(f.finish(f.copy("toReversed")).fact.kind).toBe("unknown");
	});

	it("bounds compile-time result expansion", () => {
		const f = fixture(257);
		expect(f.finish(f.copy("toReversed")).fact.kind).toBe("unknown");
	});

	it.each([
		"Array.of(1,2,3)",
		"[1,2,3].toReversed()",
		"[1,2,3].with(0, 9)",
		"[1,2,3].toSpliced(1, 1, 9)",
		"[1,2,3].slice(1)",
		"[1,2].concat([3], 4)",
		"[1,,2].flat(0)",
		"[1,,2].flat()",
	])("removes the producer and allocation when searching %s", (expression) => {
		const output = inspectStaticValueFunction(
			`function target(x) { return ${expression}.includes(x); } globalThis.target = target;`,
			"target",
		);
		expect(output.structure.allocations).toBe(0);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
	});

	it.each([
		"[x,x].toReversed()",
		"Array.of(x,x)",
		"[x,x].slice()",
		"[x,,x].concat([x])",
		"[x,,x].flat(0)",
		"[[x,,x]].flat()",
	])("materializes %s as a fresh shell sharing dynamic children", (expression) => {
		const output = inspectStaticValueFunction(
			`function target(x) { return ${expression}; } globalThis.target = target;`,
			"target",
		);
		expect(output.structure.allocations).toBe(1);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
	});
});
