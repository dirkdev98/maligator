import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("catalogued primitive builtin result storage", () => {
	it.each([
		["Number", "Number(input)"],
		["Date.parse", "Date.parse(input)"],
		["Object.hasOwn", "Object.hasOwn(input, other)"],
		["Object.is", "Object.is(input, other)"],
		["Map.prototype.has", "Map.prototype.has.call(input, other)"],
	] as const)(
		"omits the root for a boxed immediate %s result",
		(operation, expression) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,gate,condition){const value=${expression};gate();return condition?value:undefined;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			const op = out.native.body.instructions[ip]!;
			if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing exact builtin call");
			expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
			expect(
				out.native.gc.safepoints.some((point) =>
					point.incomingRootRegisters.includes(op.dst),
				),
			).toBe(true);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([
		"synthetic",
		"raw storage",
		"second writer",
		"input alias",
		"construct",
		"spread",
		"heap result",
	])("retains a boxed builtin root after %s invalidates its certificate", (kind) => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate,condition){const value=Number(input);gate();return condition?value:undefined;}globalThis.compute=compute;",
			"compute",
		);
		const instructions = [...out.native.body.instructions];
		const ip = instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number",
		);
		const op = instructions[ip]!;
		if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing Number call");
		const storageValues = [...out.native.storageValues!];
		if (kind === "synthetic") storageValues[op.dst] = -1;
		else if (kind === "second writer")
			instructions.push({ opcode: "MOVE", dst: op.dst, src: op.dst });
		else if (kind === "input alias") instructions[ip] = { ...op, arguments: [op.dst] };
		else if (kind === "construct") instructions[ip] = { ...op, construct: true };
		else if (kind === "spread") instructions[ip] = { ...op, argumentMode: "array" };
		else instructions[ip] = { ...op, operation: "String" };
		const native = {
			...out.native,
			storageValues: kind === "raw storage" ? undefined : storageValues,
			body: { ...out.native.body, instructions },
		};
		expect(lowerNativeFunctionStorage(native).storage!.rootRegisters).toContain(op.dst);
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it.each([
		"function compute(input,gate,condition){try{const value=Number(input);gate();return condition?value:undefined;}catch(error){return error;}}",
		"async function compute(input,gate,condition){const value=Number(input);await gate();return condition?value:undefined;}",
	])("retains boxed roots in protected or suspended builtin storage", (source) => {
		const out = inspectStaticValueFunction(
			`${source}globalThis.compute=compute;`,
			"compute",
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number",
		)!;
		if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing Number call");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
		expect(out.native.storage!.rootRegisters).toContain(op.dst);
	});

	it.each([
		["Date.now", "Date.now()", "number"],
		["Date.parse", "Date.parse(input)", "number"],
		["Date.UTC", "Date.UTC(input, 0)", "number"],
		["Object.is", "Object.is(input, other)", "boolean"],
		["Object.hasOwn", "Object.hasOwn(input, other)", "boolean"],
	] as const)(
		"keeps %s scalar across a collecting callback",
		(operation, expression, rep) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,gate){const value=${expression};gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			)!;
			if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing exact builtin call");
			expect(out.native.registerRepresentations[op.dst]).toBe(rep);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
			if (["Date.parse", "Date.UTC", "Object.hasOwn"].includes(operation))
				expect(out.c.source).toMatch(
					/MalValue __boxed_load_\d+ = [^;]+;\n\s+if \([^\n]+\) goto __throw_exit;\n\s+r\d+ = mal_(?:ops_number_as_f64|value_to_boolean)\(__boxed_load_\d+\);/,
				);
		},
	);

	it.each([
		["Map", "has"],
		["Map", "delete"],
		["Set", "has"],
		["Set", "delete"],
	] as const)("keeps exact %s.%s results Boolean", (family, method) => {
		const out = inspectStaticValueFunction(
			`function compute(input,other,gate){const value=${family}.prototype.${method}.call(input,other);gate();return value;}globalThis.compute=compute;`,
			"compute",
		);
		const op = out.native.body.instructions.find(
			(op) =>
				op.opcode === "CALL_KNOWN" && op.operation === `${family}.prototype.${method}`,
		)!;
		if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing collection predicate");
		expect(out.native.registerRepresentations[op.dst]).toBe("boolean");
		expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		["some", "boolean"],
		["every", "boolean"],
		["findIndex", "number"],
		["findLastIndex", "number"],
	] as const)(
		"keeps %s results scalar while callback dispatch can collect or throw",
		(method, rep) => {
			const out = inspectStaticValueFunction(
				`function compute(input,predicate,gate){const values=[input,3];const value=values.${method}(predicate);gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find(
				(op) =>
					op.opcode === "CALL_KNOWN" && op.operation === `Array.prototype.${method}`,
			)!;
			if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing array callback call");
			expect(out.native.registerRepresentations[op.dst]).toBe(rep);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.c.source).toContain("mal_vm_call_known_native");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
});
