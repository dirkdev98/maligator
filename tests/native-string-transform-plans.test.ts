import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { decodeVmValueOperand } from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(expression: string) {
	return inspectStaticValueFunction(
		`function compute(input,other){return ${expression};}globalThis.compute=compute;`,
		"compute",
	);
}

describe("persisted native String transforms", () => {
	it.each([
		["String(input).normalize()", { kind: "normalize", form: "NFC" }],
		["String(input).normalize('NFD')", { kind: "normalize", form: "NFD" }],
		["String(input).normalize('NFKC')", { kind: "normalize", form: "NFKC" }],
		["String(input).normalize('NFKD')", { kind: "normalize", form: "NFKD" }],
		["String(input).toUpperCase()", { kind: "case", upper: true, locale: "root" }],
		[
			"String(input).toLocaleLowerCase('az')",
			{ kind: "case", upper: false, locale: "turkic" },
		],
		[
			"String(input).toLocaleUpperCase('lt')",
			{ kind: "case", upper: true, locale: "lithuanian" },
		],
		[
			"String(input).toLocaleLowerCase('en-US')",
			{ kind: "case", upper: false, locale: "root" },
		],
		["String(input).trimLeft()", { kind: "trim", start: true, end: false }],
		["String(input).trimRight()", { kind: "trim", start: false, end: true }],
		["String(input).isWellFormed()", { kind: "is-well-formed" }],
		["String(input).toWellFormed()", { kind: "to-well-formed" }],
		["String(input).bold()", { kind: "html", tag: "b" }],
		["String(input).anchor(other)", { kind: "html", tag: "a", attribute: "name" }],
	])("persists the selected kernel for %s", (expression, expected) => {
		const out = inspect(expression);
		expect(out.native.storage!.stringTransforms).toHaveLength(1);
		expect(out.native.storage!.stringTransforms[0]).toMatchObject({
			...expected,
			receiver: "string",
			fallback: "original-call",
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		"String(input).normalize(other)",
		"String(input).normalize('bad')",
		"String(input).toLocaleLowerCase(other)",
		"String(input).toLocaleLowerCase('bad_locale')",
		"String(input).toLocaleUpperCase('en-US-x-longer-than-sixteen')",
	])("retains the original call for %s", (expression) => {
		const out = inspect(expression);
		expect(out.native.storage!.stringTransforms).toEqual([]);
	});

	it("selects receiver guards separately for canonical and typed entries", () => {
		const out = inspect("String.prototype.trim.call(input)");
		const reps = [...out.native.registerRepresentations];
		reps[0] = "string";
		const native = lowerNativeFunctionStorage({
			...out.native,
			directEntries: [
				{
					id: 0,
					parameterRepresentations: ["string", "boxed"],
					resultRepresentation: "boxed",
					registerRepresentations: reps,
					gc: out.native.gc,
				},
			],
		});
		expect(native.storage!.stringTransforms[0]!.receiver).toBe("guarded");
		expect(native.directEntries[0]!.storage!.stringTransforms[0]!.receiver).toBe(
			"string",
		);
		validateNativeStorage(native);
		expect(() =>
			validateNativeStorage({
				...native,
				storage: {
					...native.storage!,
					stringTransforms: native.directEntries[0]!.storage!.stringTransforms,
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("consumes exact receiver facts without removing boxed receiver roots", () => {
		const out = inspect("String.prototype.trim.call(input)");
		const ip = out.native.storage!.stringTransforms[0]!.instructionIp;
		const instructions = [...out.native.instructions];
		instructions[ip] = {
			kind: "exact-builtin-input-kinds",
			inputKindMasks: [COMPILER_VALUE_KIND_STRING],
		};
		const native = lowerNativeFunctionStorage({ ...out.native, instructions });
		expect(native.storage!.stringTransforms[0]!.receiver).toBe("string");
		expect(native.storage!.rootRegisters).toContain(0);
		instructions[ip] = {
			kind: "exact-builtin-input-kinds",
			inputKindMasks: [COMPILER_VALUE_KIND_TOP],
		};
		expect(() => validateNativeStorage({ ...native, instructions })).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("rejects stale normalization and locale plans after a string-pool change", () => {
		for (const expression of [
			"String(input).normalize('NFD')",
			"String(input).toLocaleLowerCase('tr')",
		]) {
			const out = inspect(expression);
			const plan = out.native.storage!.stringTransforms[0]!;
			const op = out.native.body.instructions[plan.instructionIp]!;
			if (op.opcode !== "CALL_KNOWN") throw new Error("Missing planned String call");
			const argument = decodeVmValueOperand(op.arguments[0]!);
			if (argument.kind !== "string")
				throw new Error("Missing constant transform parameter");
			const constants = out.image.runtime.stringConstants.with(
				argument.index,
				[..."bad"].map((unit) => unit.charCodeAt(0)),
			);
			expect(() => validateNativeStorage(out.native, new Map(), constants)).toThrow(
				/invalid or stale storage plan/,
			);
			const selected = lowerNativeFunctionStorage(out.native, new Map(), constants);
			expect(selected.storage!.stringTransforms).toEqual([]);
		}
	});
});
