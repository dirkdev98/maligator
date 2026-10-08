import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function conditional(expression: string, profile = false, preamble = "", setup = "") {
	return inspectStaticValueFunction(
		`${preamble} function maybe(flag,left,right){const a=+left,b=+right;${setup}return flag?${expression}:undefined;}globalThis.maybe=maybe;`,
		"maybe",
		{ profile },
	);
}

describe("boxed scalar expressions at phi boundaries", () => {
	it.each(["a===b", "a!==b", "!a"])(
		"boxes %s from physical Boolean inputs",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function maybe(flag,left,right){const a=!!left,b=!!right;return flag?${expression}:undefined;}globalThis.maybe=maybe;`,
				"maybe",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) =>
					(op.opcode === "BINARY" || op.opcode === "UNARY") &&
					out.native.registerRepresentations[op.dst] === "boxed",
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY" && op.opcode !== "UNARY")
				throw new Error("Missing Boolean operator");
			const input = op.opcode === "UNARY" ? op.src : op.left;
			expect(out.native.registerRepresentations[input]).toBe("boolean");
			expect(out.native.storage!.expressionIps).toContain(ip);
			expect(out.c.source).toContain(`#define r${op.dst} (mal_value_new_boolean(`);
		},
	);

	it("boxes an unsigned-arithmetic result at a mixed phi", () => {
		const out = inspectStaticValueFunction(
			"function maybe(flag,left){const n=+left;const a=n&65535;return flag?(a*3+1)%101:undefined;}globalThis.maybe=maybe;",
			"maybe",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "%",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "BINARY") throw new Error("Missing remainder");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
		expect(out.native.instructions[ip]).toMatchObject({ kind: "unsigned-arithmetic" });
		expect(out.native.storage!.expressionIps).toContain(ip);
		expect(out.c.source).toContain(`#define r${op.dst} (mal_ops_number_value((f64)`);
	});

	it("keeps the mixed phi rooted when the other edge can carry a heap value", () => {
		const out = inspectStaticValueFunction(
			"function maybe(flag,left,right,gate){const a=+left,b=+right;const value=flag?a*b:left;gate();return value;}globalThis.maybe=maybe;",
			"maybe",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		const product = out.native.body.instructions[ip]!;
		if (product.opcode !== "BINARY") throw new Error("Missing product");
		const copy = out.native.body.instructions.find(
			(op) => op.opcode === "MOVE" && op.src === product.dst,
		)!;
		if (copy.opcode !== "MOVE") throw new Error("Missing mixed phi");
		expect(out.native.storage!.expressionIps).toContain(ip);
		expect(out.native.storage!.rootRegisters).not.toContain(product.dst);
		expect(out.native.storage!.rootRegisters).toContain(copy.dst);
	});

	it.each([
		["a+b", "+", "mal_ops_number_value("],
		["a-b", "-", "mal_ops_number_value("],
		["a*b", "*", "mal_ops_number_value("],
		["a/b", "/", "mal_ops_number_value("],
		["a%b", "%", "mal_ops_number_value(mal_number_remainder("],
		["a>>>b", ">>>", "mal_ops_number_value((f64) ((u32)"],
		["a<<b", "<<", "mal_value_from_i32("],
		["a>>b", ">>", "mal_value_from_i32("],
		["a&b", "&", "mal_value_from_i32("],
		["a|b", "|", "mal_value_from_i32("],
		["a^b", "^", "mal_value_from_i32("],
		["a<b", "<", "mal_value_new_boolean("],
		["a===b", "===", "mal_value_new_boolean("],
		["a!==b", "!==", "mal_value_new_boolean("],
		["!a", "!", "mal_value_new_boolean(!mal_number_is_truthy("],
		["-a", "-", "mal_ops_number_value(-("],
		["~a", "~", "mal_value_from_i32(~"],
	])(
		"delays %s into its boxed phi copy with the operator's result encoding",
		(expression, operator, encoding) => {
			const out = conditional(expression);
			const ip = out.native.body.instructions.findIndex(
				(op) =>
					(op.opcode === "BINARY" || op.opcode === "UNARY") &&
					op.operator === operator &&
					out.native.registerRepresentations[op.dst] === "boxed",
			);
			const op = out.native.body.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Missing boxed operator producer");
			const copy = out.native.body.instructions.find(
				(candidate) => candidate.opcode === "MOVE" && candidate.src === op.dst,
			)!;
			if (copy.opcode !== "MOVE") throw new Error("Missing boxed phi copy");
			expect(out.native.registerRepresentations[copy.dst]).toBe("boxed");
			expect(out.native.storage!.expressionIps).toContain(ip);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.c.source).toContain(`#define r${op.dst} (${encoding}`);
			expect(out.c.source).not.toMatch(new RegExp(`MalValue r${op.dst}\\b`));
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("keeps proven immediate storage untraced when a conservative image retains its expression", () => {
		const out = conditional("a*b");
		const product = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		)!;
		if (product.opcode !== "BINARY") throw new Error("Missing product");
		const native = lowerNativeFunctionStorage({
			...out.native,
			gc: {
				safepoints: out.native.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: [...new Set([...point.rootRegisters, product.dst])].sort(
						(a, b) => a - b,
					),
					incomingRootRegisters: [
						...new Set([...point.incomingRootRegisters, product.dst]),
					].sort((a, b) => a - b),
					outgoingRootRegisters: [
						...new Set([...point.outgoingRootRegisters, product.dst]),
					].sort((a, b) => a - b),
				})),
			},
		});
		expect(
			native.gc.safepoints.some((point) => point.rootRegisters.includes(product.dst)),
		).toBe(true);
		expect(native.storage!.rootRegisters).not.toContain(product.dst);
		const retained = lowerNativeFunctionStorage({
			...native,
			body: { ...native.body, profileSiteIds: native.body.instructions.map(() => -1) },
		});
		expect(retained.storage!.rootRegisters).not.toContain(product.dst);
		const weaker = {
			...native,
			storage: {
				...retained.storage!,
				rematerializedConstantIps: native.storage!.rematerializedConstantIps,
			},
		};
		expect(() => validateNativeStorage(weaker)).not.toThrow();
		expect(emitCompiledFunction(weaker, weaker.functionIndex, "", false)).not.toBeNull();
		expect(() =>
			validateNativeStorage({
				...native,
				storage: { ...native.storage!, expressionIps: [] },
			}),
		).not.toThrow();
	});

	it("retains a phi producer whose exact Number input still occupies boxed storage", () => {
		const out = conditional("a*b", false, "let saved;", "saved=a;");
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "BINARY") throw new Error("Missing product");
		expect(out.native.registerRepresentations[op.left]).toBe("boxed");
		expect(out.native.instructions[ip]).toMatchObject({
			kind: "exact-operator-input-kinds",
		});
		expect(out.native.storage!.expressionIps).not.toContain(ip);
	});

	it("rejects a retained boxed intermediate that invalidates a helper's scalar leaf proof", () => {
		const out = inspectStaticValueFunction(
			"function maybe(left,right,callback){const a=+left,b=+right;callback((a-b)*2);return 0;}globalThis.maybe=maybe;",
			"maybe",
		);
		const subtractionIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "-",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		const subtraction = out.native.body.instructions[subtractionIp]!;
		if (subtraction.opcode !== "BINARY") throw new Error("Missing subtraction");
		const native = lowerNativeFunctionStorage({
			...out.native,
			registerRepresentations: out.native.registerRepresentations.map((rep, local) =>
				local === subtraction.dst ? "boxed" : rep,
			),
		});
		expect(native.storage!.expressionIps).toContain(subtractionIp);
		expect(native.storage!.expressionIps).toContain(productIp);
		const stored = {
			...native.storage!,
			expressionIps: native.storage!.expressionIps.filter((ip) => ip !== subtractionIp),
		};
		expect(() => validateNativeStorage({ ...native, storage: stored })).toThrow(
			/invalid or stale storage plan/,
		);
		expect(() =>
			validateNativeStorage({
				...native,
				storage: { ...native.storage!, expressionIps: [] },
			}),
		).not.toThrow();
	});

	it("keeps coercive mixed-kind arithmetic materialized before phi transport", () => {
		const out = inspectStaticValueFunction(
			"function maybe(flag,a,b){return flag?a+b:undefined;}globalThis.maybe=maybe;",
			"maybe",
		);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === "BINARY");
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).not.toContain(ip);
	});

	it("retains profiled boxed operator sites", () => {
		const out = conditional("a<b", true);
		expect(out.native.storage!.expressionIps).toEqual([]);
		expect(out.c.source).toContain("MAL_PROFILE_SITE_EXECUTION");
	});
});
