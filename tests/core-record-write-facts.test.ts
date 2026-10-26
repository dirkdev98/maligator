import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function fieldRead(out: ReturnType<typeof inspectStaticValueFunction>) {
	const ip = out.native.body.instructions.findIndex(
		(op) =>
			(op.opcode === "LOAD_PROPERTY_STATIC" ||
				op.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
			String.fromCharCode(...out.image.runtime.stringConstants[op.stringIndex]!) ===
				"value",
	);
	const op = out.native.body.instructions[ip];
	if (
		op?.opcode !== "LOAD_PROPERTY_STATIC" &&
		op?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
	)
		throw new Error("Missing field read");
	return { ip, op };
}

describe("normal field facts after own writes", () => {
	it("projects producer bounds through constructing spread calls", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(value,flag,hook){const record=flag?{value:value&15}:{value:value&7};for(let step=0;step<3;step++)hook(step);record.value=value&255;return record;};function compute(value,flag,hook){const record=new make(...[value,flag,hook]);hook();return record.value;}globalThis.make=make;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip, op } = fieldRead(out);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
		expect(out.native.registerRepresentations[op.dst]).toBe("int32");
	});
	it.each([
		["value&255", COMPILER_VALUE_KIND_NUMBER, "int32", { minimum: 0, maximum: 255 }],
		[
			"value>>>0",
			COMPILER_VALUE_KIND_NUMBER,
			"number",
			{ minimum: 0, maximum: 4294967295 },
		],
		["-0", COMPILER_VALUE_KIND_NUMBER, "number", undefined],
		[
			"'changed'",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			"boxed",
			undefined,
		],
	] as const)(
		"publishes caller bounds after a producer's %s write",
		(expression, mask, representation, range) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,flag,hook){const record=flag?{value:value&15}:{value:value&7};for(let step=0;step<3;step++)hook(step);if(flag)record.value=${expression};return record;};function compute(value,flag,hook){const record=make(value,flag,hook);hook();return record.value;}globalThis.make=make;globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const { ip, op } = fieldRead(out);
			expect(out.native.facts![ip]!.resultKindMasks).toEqual([mask]);
			if (range === undefined)
				expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
			else expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject(range);
			expect(out.native.registerRepresentations[op.dst]).toBe(representation);
			expect(
				serializeCompilerArtifact(
					deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
				),
			).toEqual(serializeCompilerArtifact(out.image));
		},
	);

	it.each([
		["function*", "yield 0;"],
		["async function", "await 0;"],
		["async function*", "yield 0;await 0;"],
	])("carries producer writes into %s field loads", (kind, suspend) => {
		const out = inspectStaticValueFunction(
			`const make=function make(value,flag,hook){const record=flag?{value:value&15}:{value:value&7};for(let step=0;step<3;step++)hook(step);if(flag)record.value=value&255;return record;};${kind} compute(value,flag,hook){const record=make(value,flag,hook);${suspend}hook();return record.value;}globalThis.make=make;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip } = fieldRead(out);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
	});
	it.each([
		["function*", "yield 0;"],
		["async function", "await 0;"],
		["async function*", "yield 0;await 0;"],
	])("carries stored field bounds across %s suspension", (kind, suspend) => {
		const out = inspectStaticValueFunction(
			`const make=function make(value,hook){for(let step=0;step<3;step++)hook(step);return {value:value&15};};
			${kind} compute(value,flag,hook){const record=make(value,hook);if(flag)record.value=value&255;${suspend}hook();return record.value;}
			globalThis.make=make;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip } = fieldRead(out);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
	});

	it.each([
		["value&255", COMPILER_VALUE_KIND_NUMBER, "int32", { minimum: 0, maximum: 255 }],
		[
			"value>>>0",
			COMPILER_VALUE_KIND_NUMBER,
			"number",
			{ minimum: 0, maximum: 4294967295 },
		],
		["+value", COMPILER_VALUE_KIND_NUMBER, "number", undefined],
		["-0", COMPILER_VALUE_KIND_NUMBER, "number", undefined],
		[
			"'changed'",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			"boxed",
			undefined,
		],
	] as const)(
		"publishes joined kind, bounds and storage for a %s write",
		(expression, mask, representation, range) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,hook){for(let step=0;step<3;step++)hook(step);return {value:value&15};};
				function compute(value,flag,hook){const record=make(value,hook);if(flag)record.value=${expression};hook();return record.value;}
				globalThis.make=make;globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const { ip, op } = fieldRead(out);
			expect(out.native.facts![ip]!.resultKindMasks).toEqual([mask]);
			if (range === undefined)
				expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
			else expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject(range);
			expect(out.native.registerRepresentations[op.dst]).toBe(representation);
			expect(
				serializeCompilerArtifact(
					deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
				),
			).toEqual(serializeCompilerArtifact(out.image));
		},
	);
});
