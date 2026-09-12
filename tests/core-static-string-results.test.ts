import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function fixture(options: { locked?: boolean; realms?: boolean } = {}) {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const input = builder.blockParameterValue(entry, 0);
	const primitive = (value: boolean | number | string | bigint | null | undefined) => {
		if (value === undefined)
			return builder.appendInstruction(entry, "createUndefined", [])[0]!;
		if (value === null) return builder.appendInstruction(entry, "createNull", [])[0]!;
		if (typeof value === "number" || typeof value === "boolean")
			return builder.appendInstruction(
				entry,
				typeof value === "number" ? "createNumber" : "createBoolean",
				[],
				{ attributes: { value } },
			)[0]!;
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
	const source = builder.appendInstruction(
		entry,
		"callKnown",
		[primitive(undefined), input],
		{
			attributes: { operation: "String" },
		},
	)[0]!;
	const split = (args: ReadonlyArray<CoreValueId> = [], receiver = source) =>
		builder.appendInstruction(entry, "callKnown", [receiver, ...args], {
			attributes: { operation: "String.prototype.split" },
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
						engine: {
							primordials: options.locked === false ? "mutable" : "locked",
							realms: options.realms ?? false,
						},
					}),
				),
			},
		);
		const fact = analysis.query(result);
		return {
			analysis,
			fact,
			description:
				fact.kind === "known"
					? program.staticDescriptions.description(fact.description)
					: undefined,
		};
	};
	return { builder, entry, input, source, primitive, split, finish };
}

describe("partially known plain string split results", () => {
	it("binds an unknown string payload into a fresh singleton array", () => {
		const f = fixture();
		const first = f.split();
		const second = f.split([f.primitive(undefined)]);
		const inspected = f.finish(second);
		expect(inspected.description).toMatchObject({
			kind: "array",
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
		expect(inspected.fact).toMatchObject({
			operands: [f.source],
			identity: { kind: "fresh-per-evaluation", value: second },
		});
		const other = inspected.analysis.query(first);
		expect(other.kind === "known" && other.identity).not.toEqual(
			inspected.fact.kind === "known" && inspected.fact.identity,
		);
	});

	it.each([undefined, 1, true, -1, 1.9, 4294967297, "0x1", " -1 "])(
		"retains the receiver for a nonzero/default ToUint32 limit %s",
		(limit) => {
			const f = fixture();
			expect(
				f.finish(f.split([f.primitive(undefined), f.primitive(limit)])).description,
			).toMatchObject({ kind: "array", length: 1 });
		},
	);

	it.each([0, -0, false, null, NaN, Infinity, -Infinity, 0.9, 4294967296, "bad", ""])(
		"describes an empty result for the ToUint32 limit %s",
		(limit) => {
			const f = fixture();
			expect(f.finish(f.split([f.source, f.primitive(limit)])).description).toMatchObject(
				{ kind: "array", length: 0, properties: [] },
			);
		},
	);

	it("retains substring search when the receiver contents are unknown", () => {
		const f = fixture();
		expect(f.finish(f.split([f.primitive(",")])).fact.kind).toBe("unknown");
	});

	it.each(["receiver", "separator", "limit"] as const)(
		"retains unknown %s behavior",
		(position) => {
			const f = fixture();
			const result =
				position === "receiver"
					? f.split([], f.input)
					: position === "separator"
						? f.split([f.input, f.primitive(0)])
						: f.split([f.primitive(undefined), f.input]);
			expect(f.finish(result).fact.kind).toBe("unknown");
		},
	);

	it("retains separator protocol behavior even when the limit is zero", () => {
		const f = fixture();
		const [separator] = f.builder.appendInstruction(f.entry, "createObject", []);
		expect(f.finish(f.split([separator!, f.primitive(0)])).fact.kind).toBe("unknown");
	});

	it("retains the BigInt limit TypeError", () => {
		const f = fixture();
		expect(f.finish(f.split([f.primitive(undefined), f.primitive(0n)])).fact.kind).toBe(
			"unknown",
		);
	});

	it("bounds numeric text conversion work", () => {
		const f = fixture();
		expect(
			f.finish(f.split([f.primitive(undefined), f.primitive("0".repeat(4097))])).fact
				.kind,
		).toBe("unknown");
	});

	it.each([{ locked: false }, { realms: true }])(
		"requires a locked current realm %j",
		(options) => {
			const f = fixture(options);
			expect(f.finish(f.split()).fact.kind).toBe("unknown");
		},
	);
});

describe("plain string split consumers", () => {
	it.each([
		"String(x).split()[0]",
		"String(x).split(undefined, -1)[0]",
		"String(x).split(undefined).length",
		"String(x).split(String(y), 0).length",
	])("removes the intermediate array for %s", (expression) => {
		const inspected = inspectStaticValueFunction(
			`function probe(x, y) { return ${expression}; } globalThis.probe = probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(inspected.structure.operations.map((operation) => operation.id)).not.toContain(
			"String.prototype.split",
		);
	});

	it("materializes a fresh escaping singleton instead of calling split", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { return String(x).split(); } globalThis.probe = probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
		expect(inspected.structure.operations.map((operation) => operation.id)).not.toContain(
			"String.prototype.split",
		);
	});

	it("retains zero-limit calls with a dynamic separator protocol", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x, separator) { return String(x).split(separator, 0); } globalThis.probe = probe;",
			"probe",
		);
		expect(inspected.structure.operations.map((operation) => operation.id)).toContain(
			"String.prototype.split",
		);
	});
});
