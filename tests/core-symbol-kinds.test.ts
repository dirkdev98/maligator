import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspectKey(expression: string, declarations = "", declaration = "function") {
	return inspectStaticValueFunction(
		`${declarations}${declaration} compute(receiver,input,flag,visit){const key=${expression};${declaration.includes("*") ? "yield key;" : ""}const value=WeakMap.prototype.get.call(receiver,key);return typeof value==='undefined'?17:11;}globalThis.compute=compute;`,
		"compute",
		{ realms: false },
	);
}

function keyKinds(out: ReturnType<typeof inspectKey>) {
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode === "CALL_KNOWN" && op.operation === "WeakMap.prototype.get",
	);
	expect(ip).toBeGreaterThanOrEqual(0);
	expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
		mayThrow: true,
		mayGc: true,
	});
	return out.native.facts![ip]!.inputKindMasks![1];
}

function keepsHit(out: ReturnType<typeof inspectKey>) {
	return out.core.some(
		(op) => op.opcode === "createNumber" && op.attributes.value === 11,
	);
}

describe("Symbol registration kinds", () => {
	it.each([
		["Symbol(input)", COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL, true],
		["Symbol.for(input)", COMPILER_VALUE_KIND_REGISTERED_SYMBOL, false],
		["flag?Symbol(input):Symbol.for(input)", COMPILER_VALUE_KIND_SYMBOL, true],
		[
			"flag?{}:Symbol(input)",
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
			true,
		],
		[
			"flag?undefined:Symbol.for(input)",
			COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
			false,
		],
		[
			"flag?{}:Symbol.for(input)",
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
			true,
		],
	] as const)("transports %s to a weak-key consumer", (expression, kind, hit) => {
		const out = inspectKey(expression);
		expect(keyKinds(out)).toBe(kind);
		expect(keepsHit(out)).toBe(hit);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["make(input,visit)", "make(...input)"])(
		"preserves registration through a non-inlined %s return",
		(call) => {
			const out = inspectKey(
				call,
				"const make=function make(input,visit){for(let i=0;i<3;i++)visit();return Symbol.for(input);};",
			);
			expect(
				out.fn.instructions.some(
					(op) =>
						op.opcode === "CALL" ||
						op.opcode === "CALL_SPREAD" ||
						op.opcode === "CALL_SPREAD_ITERABLE",
				),
			).toBe(true);
			expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_REGISTERED_SYMBOL);
			expect(keepsHit(out)).toBe(false);
		},
	);

	it("propagates registration through recursive returns", () => {
		const out = inspectKey(
			"make(input,flag,visit)",
			"const make=function make(input,count,visit){if(count>0)return make(input,count-1,visit);for(let i=0;i<3;i++)visit();return Symbol.for(input);};",
		);
		expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_REGISTERED_SYMBOL);
		expect(keepsHit(out)).toBe(false);
	});

	it("propagates registration through a returned record field", () => {
		const out = inspectKey(
			"make(input,visit).key",
			"const make=function make(input,visit){for(let i=0;i<3;i++)visit();return {key:Symbol.for(input)};};",
		);
		expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_REGISTERED_SYMBOL);
		expect(keepsHit(out)).toBe(false);
	});

	it("preserves registration through primitive Symbol unboxing", () => {
		const out = inspectKey("Symbol.prototype.valueOf.call(Symbol.for(input))");
		expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_REGISTERED_SYMBOL);
		expect(keepsHit(out)).toBe(false);
	});

	it("keeps both registration alternatives when unboxing an unknown Symbol wrapper", () => {
		const out = inspectKey("Symbol.prototype.valueOf.call(Object(input))");
		expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_SYMBOL);
		expect(keepsHit(out)).toBe(true);
	});

	it("preserves a registered Symbol across suspension", () => {
		const out = inspectKey("Symbol.for(input)", "", "function*");
		expect(keyKinds(out)).toBe(COMPILER_VALUE_KIND_REGISTERED_SYMBOL);
		expect(keepsHit(out)).toBe(false);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		["Symbol(input)", COMPILER_VALUE_KIND_UNDEFINED],
		["Symbol.for(input)", COMPILER_VALUE_KIND_STRING],
	] as const)("uses %s to constrain Symbol.keyFor normal results", (key, expected) => {
		const out = inspectStaticValueFunction(
			`const make=function make(input,visit){for(let i=0;i<3;i++)visit();return ${key};};function compute(input,visit){return Symbol.keyFor(make(input,visit));}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Symbol.keyFor",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([expected]);
	});

	it("does not assume a mutable Symbol.for returns a registered Symbol", () => {
		const out = inspectStaticValueFunction(
			"function compute(receiver,input){return WeakMap.prototype.get.call(receiver,Symbol.for(input))===undefined?17:11;}globalThis.compute=compute;",
			"compute",
			{ realms: false, locked: false },
		);
		expect(keepsHit(out)).toBe(true);
	});

	it("uses a registered Symbol returned by a call to lower keyFor's string length", () => {
		const out = inspectStaticValueFunction(
			"const make=function make(input,visit){for(let i=0;i<3;i++)visit();return Symbol.for(input);};function compute(input,visit){return Symbol.keyFor(make(input,visit)).length;}globalThis.compute=compute;",
			"compute",
			{ realms: false },
		);
		expect(out.core.some((op) => op.attributes.primitiveStringLength === true)).toBe(
			true,
		);
		expect(out.c.source).not.toContain("mal_vm_get_property_static");
	});
});
