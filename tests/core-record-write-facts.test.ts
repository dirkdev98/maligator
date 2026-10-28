import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
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
	it.each([
		["number", "", COMPILER_VALUE_KIND_NUMBER, "number"],
		["string", "", COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING, "boxed"],
		["number", "record.value=value;", COMPILER_VALUE_KIND_TOP, "boxed"],
	] as const)(
		"publishes the %s writer guard through calls without narrowing later writes (%s)",
		(kind, overwrite, mask, representation) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,hook){for(let i=0;i<3;i++)hook(i);const record={value:0};if(typeof value==='${kind}')record.value=value;${overwrite}return record;};function compute(value,hook){const record=make(value,hook);hook();return record.value+1;}globalThis.make=make;globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const { ip, op } = fieldRead(out);
			expect(out.native.facts![ip]!.resultKindMasks).toEqual([mask]);
			expect(out.native.registerRepresentations[op.dst]).toBe(representation);
			if (representation === "number") expect(out.c.source).not.toContain("MAL_BIN_ADD");
			else expect(out.c.source).toContain("MAL_BIN_ADD");
		},
	);

	it.each([
		[
			"value>>>0",
			COMPILER_VALUE_KIND_NUMBER,
			"number",
			{ minimum: 0, maximum: 4294967295 },
		],
		["-0", COMPILER_VALUE_KIND_NUMBER, "number", undefined],
		[
			"value+':'",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			"boxed",
			undefined,
		],
	] as const)(
		"preserves wide or boxed forwarding storage for %s",
		(expression, mask, representation, range) => {
			const out = inspectStaticValueFunction(
				`const leaf=function leaf(value,hook){hook(new.target);return {value:value&15};};const forward=function forward(value,flag,hook){const record=leaf(value,hook);hook(new.target);if(flag)record.value=${expression};return record;};function compute(value,flag,hook){const record=forward(value,flag,hook);const saved=record.value;hook();return saved;}globalThis.leaf=leaf;globalThis.forward=forward;globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const { ip, op } = fieldRead(out);
			expect(out.native.facts![ip]!.resultKindMasks).toEqual([mask]);
			if (range === undefined)
				expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
			else expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject(range);
			expect(out.native.registerRepresentations[op.dst]).toBe(representation);
		},
	);

	it.each([
		["function*", "yield 0;"],
		["async function", "await 0;"],
		["async function*", "yield 0;await 0;"],
	])("carries forwarding writes across %s suspension", (declaration, suspend) => {
		const out = inspectStaticValueFunction(
			`const leaf=function leaf(value,hook){hook(new.target);return {value:value&15};};const forward=function forward(value,flag,hook){const record=leaf(value,hook);hook(new.target);if(flag)record.value=value&255;return record;};${declaration} compute(value,flag,hook){const record=forward(value,flag,hook);${suspend}hook();return record.value%10;}globalThis.leaf=leaf;globalThis.forward=forward;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip } = fieldRead(out);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
		expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
	});

	it("widens unbounded recursive forwarding writes beyond integer kernels", () => {
		const out = inspectStaticValueFunction(
			`const first=function first(n,hook){const record=n>0?second(n-1,hook):{value:0};hook(new.target);record.value=+record.value+1;return record;};const second=function second(n,hook){hook(new.target);return first(n,hook);};function compute(n,hook){return first(n,hook).value%10;}globalThis.first=first;globalThis.second=second;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip } = fieldRead(out);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
		expect(out.c.source).toContain("mal_number_remainder(");
	});

	it.each([
		"forward(value,flag,hook)",
		"new forward(value,flag,hook)",
		"new forward(...[value,flag,hook])",
	])("projects private forwarding writes across %s", (call) => {
		const out = inspectStaticValueFunction(
			`const leaf=function leaf(value,hook){hook(new.target);return {value:value&15};};const forward=function forward(value,flag,hook){const record=leaf(value,hook);hook(new.target);if(flag)record.value=value&255;return record;};function compute(value,flag,hook){const record=${call};hook();return record.value%10;}globalThis.leaf=leaf;globalThis.forward=forward;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		const { ip, op } = fieldRead(out);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
		expect(out.native.registerRepresentations[op.dst]).toBe("int32");
		expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
		expect(out.c.source).not.toContain("mal_number_remainder(");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

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
