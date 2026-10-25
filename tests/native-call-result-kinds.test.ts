import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunctions } from "./helpers/static-values.ts";

function inspectCall(body: string, caller: string, kind = "function") {
	const out = inspectStaticValueFunctions(
		`const leaf=${kind} leaf(value,hook){try{hook();${body}}catch(error){hook(error);throw error;}};
		${caller}globalThis.leaf=leaf;globalThis.compute=compute;`,
		["compute"],
		{ locked: false },
	).get("compute")!;
	const ip = out.native.body.instructions.findIndex(
		(op, ip) =>
			["CALL", "CALL_SPREAD", "CALL_REST_ARGUMENTS", "CALL_SPREAD_ITERABLE"].includes(
				op.opcode,
			) && out.native.facts?.[ip]?.resultKindMasks?.[0] !== COMPILER_VALUE_KIND_TOP,
	);
	if (ip < 0) throw new Error("Missing bounded call result");
	const op = out.native.body.instructions[ip]!;
	if (!("dst" in op)) throw new Error("Missing call destination");
	return { ...out, ip, op, facts: out.native.facts![ip]! };
}

describe("normal script call result facts", () => {
	it.each(["async function", "function*", "async function*"])(
		"retains the object returned by %s despite its numeric body result",
		(kind) => {
			const out = inspectCall(
				"return value|0;",
				"function compute(value,hook,gate){const result=leaf(value,hook);gate();return result;}",
				kind,
			);
			expect(out.facts.resultKindMasks).toEqual([COMPILER_VALUE_KIND_OBJECT]);
			expect(out.facts.resultIntegerRanges).toBeUndefined();
			expect(out.native.registerRepresentations[out.op.dst]).toBe("boxed");
			expect(out.native.storage!.rootRegisters).toContain(out.op.dst);
		},
	);

	it.each([
		[false, "+value", undefined],
		[true, "+value", undefined],
		[false, "(value&255)+1", undefined],
		[
			true,
			"(value&255)+1",
			{ minimum: 1, maximum: 256, exactSafeIntegers: true, excludesNegativeZero: true },
		],
	] as const)(
		"uses whole-program call inputs only with a closure certificate: %s, %s",
		(closed, expression, range) => {
			const sourcePath = "/call-result-closed.mjs";
			const source = `const identity=function identity(value,hook){try{hook();return value;}catch(error){throw error;}};
			function compute(value,hook,gate){const result=identity(${expression},hook);gate();return result+1;}
			globalThis.compute=compute;`;
			const facts = compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { eval: false, primordials: "mutable" } }),
			);
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, sourcePath),
				{
					facts: closed
						? withProgramClosure(
								facts,
								programClosureCertificate(
									{ kind: "whole-program", entry: sourcePath },
									[{ kind: "entry-module", module: sourcePath }],
									[],
								),
							)
						: facts,
				},
			);
			const native = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "compute",
			)!;
			const ip = native.body.instructions.findIndex(
				(op) => op.opcode === "CALL" && op.arguments.length === 2,
			);
			const op = native.body.instructions[ip]!;
			if (op.opcode !== "CALL") throw new Error("Missing closed call");
			expect(native.facts![ip]!.resultKindMasks).toEqual([
				closed ? COMPILER_VALUE_KIND_NUMBER : COMPILER_VALUE_KIND_TOP,
			]);
			expect(native.facts![ip]!.resultIntegerRanges?.[0]).toEqual(range);
			expect(native.registerRepresentations[op.dst]).toBe(
				closed ? (range === undefined ? "number" : "int32") : "boxed",
			);
			if (closed) {
				expect(
					native.storage!.callTransports.some((call) => call.instructionIp === ip),
				).toBe(true);
				const c = emitCompiledFunction(native, native.functionIndex, "", false)!;
				expect(c.source).not.toContain(`mal_ops_is_number(r${op.dst})`);
			}
		},
	);

	it.each([
		["return value|0;", COMPILER_VALUE_KIND_NUMBER, "int32"],
		["return +value;", COMPILER_VALUE_KIND_NUMBER, "number"],
		["return !!value;", COMPILER_VALUE_KIND_BOOLEAN, "boolean"],
		["return value+':';", COMPILER_VALUE_KIND_STRING, "string"],
	] as const)("keeps %s independent of call effects", (body, mask, representation) => {
		const out = inspectCall(
			body,
			"function compute(value,hook,gate){const result=leaf(value,hook);gate();return result+1;}",
		);
		expect(out.facts.resultKindMasks).toEqual([mask]);
		expect(out.native.registerRepresentations[out.op.dst]).toBe(representation);
		const effects = out.facts.effectMask;
		if (effects === undefined) throw new Error("Missing call effects");
		for (const effect of [
			INSTRUCTION_MAY_THROW,
			INSTRUCTION_MAY_GC,
			INSTRUCTION_CALLS_USER_CODE,
		])
			expect(effects & effect).not.toBe(0);
		expect(out.native.gc.safepoints.some((point) => point.instructionIp === out.ip)).toBe(
			true,
		);
		expect(out.native.storage!.rootRegisters.includes(out.op.dst)).toBe(
			mask === COMPILER_VALUE_KIND_STRING,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		[
			"return value?value|0:undefined;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED,
			false,
		],
		["return -value;", COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BIGINT, true],
	] as const)("preserves the partial union from %s", (body, mask, rooted) => {
		const out = inspectCall(
			body,
			"function compute(value,hook,gate){const result=leaf(value,hook);gate();return ':'+result;}",
		);
		expect(out.facts.resultKindMasks).toEqual([mask]);
		expect(out.native.registerRepresentations[out.op.dst]).toBe("boxed");
		expect(out.native.storage!.rootRegisters.includes(out.op.dst)).toBe(rooted);
		expect(out.c.source).toContain("mal_vm_concat_primitive_strings(");
		expect(out.c.source).not.toContain("MAL_BIN_ADD");
	});

	it.each([
		"function compute(args){return leaf(...args)+1;}",
		"function compute(...args){return leaf(...args)+1;}",
		"function* compute(value,hook,gate){const result=leaf(value,hook);yield result;gate();return result+1;}",
		"function* compute(value,hook,gate){yield 0;const result=leaf(value,hook);gate();return result+1;}",
	])("transports the result through %s", (caller) => {
		const out = inspectCall("return value|0;", caller);
		expect(out.facts.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		const native = restored.native.functions[out.native.functionIndex]!;
		const source = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		if (native.registerRepresentations[out.op.dst] === "number")
			expect(source).toMatch(
				/mal_ops_number_as_f64\(call_(?:result|spread|rest|spread_iterable)_\d+\.value\)/,
			);
		expect(source).not.toContain("MAL_BIN_ADD");
	});

	it("does not turn a guarded callee hint into a normal result proof", () => {
		const out = inspectStaticValueFunctions(
			`function leaf(value,hook){try{hook();return value|0;}catch(error){throw error;}}
			function compute(value,hook,gate){const result=leaf(value,hook);gate();return result+1;}
			globalThis.leaf=leaf;globalThis.compute=compute;globalThis.seed=leaf(1,()=>{});`,
			["compute"],
			{ locked: false },
		).get("compute")!;
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" && op.arguments.length === 2,
		);
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([COMPILER_VALUE_KIND_TOP]);
		expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
		expect(out.c.source).toContain("mal_ops_is_number(");
	});

	it("joins every possible exact callee before assigning the result kind", () => {
		const out = inspectStaticValueFunctions(
			`const number=function number(value,hook){try{hook();return value|0;}catch(error){throw error;}};
			const object=function object(value,hook){try{hook();return {value};}catch(error){throw error;}};
			function compute(value,hook,gate,flag){const callee=flag?number:object;const result=callee(value,hook);gate();return result+1;}
			globalThis.number=number;globalThis.object=object;globalThis.compute=compute;`,
			["compute"],
			{ locked: false },
		).get("compute")!;
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" && op.arguments.length === 2,
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CALL") throw new Error("Missing finite call");
		expect(out.native.facts![ip]!.resultKindMasks).toEqual([
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_OBJECT,
		]);
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
		expect(out.native.storage!.rootRegisters).toContain(op.dst);
	});
});
