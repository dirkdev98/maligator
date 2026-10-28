import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { boxedNativeFactContract } from "./helpers/boxed-native-facts.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("SameValue hit and fallback contracts", () => {
	it.each([
		["(input>>>0)+1", "+other", false],
		["+input", "(other>>>0)+1", false],
		["(input>>>0)+1", "(other>>>0)+1", false],
		["input>>>0", "+other", true],
		["+input", "other>>>0", true],
	] as const)("uses partial numeric ranges for %s and %s", (left, right, signedZero) => {
		for (const locked of [false, true]) {
			const out = inspectStaticValueFunction(
				`function compute(input,other){const left=${left},right=${right};return Object.is(left,right);}globalThis.compute=compute;`,
				"compute",
				{ locked },
			);
			expect(out.c.source).not.toContain("isnan(");
			expect(out.c.source.includes("signbit(")).toBe(signedZero);
			expect(out.c.source).not.toContain("mal_ops_same_value(");
			if (!locked) expect(out.c.source).toContain("mal_vm_call_cached");
		}
	});

	it.each([false, true])("retains loaded-callee authority with locked=%s", (locked) => {
		const out = inspectStaticValueFunction(
			"function compute(input,other,gate){const result=Object.is(input,other);gate();return [result,input];}globalThis.compute=compute;",
			"compute",
			{ locked, stackRoots: "precise" },
		);
		const ip = out.native.body.instructions.findIndex((op, index) =>
			locked
				? op.opcode === "CALL_KNOWN" && op.operation === "Object.is"
				: op.opcode === "CALL" && out.native.instructions[index]?.kind === "call",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CALL" && op.opcode !== "CALL_KNOWN")
			throw new Error("Missing SameValue call");
		if (!locked) {
			const plan = out.native.instructions[ip];
			expect(plan?.kind === "call" ? plan.guardedBuiltinCall?.operation : undefined).toBe(
				"Object.is",
			);
			expect(out.native.storage!.rootRegisters).toContain(op.dst);
			expect(out.c.source).toContain("mal_builtin_object_is_callee_matches");
			expect(out.c.source).toContain("mal_vm_call_cached");
		}
		expect(out.c.source).toContain("mal_ops_same_value");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["Object.is(input,input)", "Object.is(+input,!!other)", "Object.is()"])(
		"uses operand facts inside the mutable hit for %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other){return ${expression};}globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			expect(out.c.source).toContain("mal_builtin_object_is_callee_matches");
			expect(out.c.source).not.toContain("mal_ops_same_value");
			expect(out.c.source).toContain("mal_vm_call_cached");
		},
	);
});

describe("catalogued primitive builtin result storage", () => {
	it.each([
		[
			"RegExp.prototype.global<get>",
			'Object.getOwnPropertyDescriptor(RegExp.prototype,"global").get.call(input)',
			COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_UNDEFINED,
			false,
		],
		[
			"JSON.stringify",
			"JSON.stringify(input,other)",
			COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_UNDEFINED,
			true,
		],
		[
			"Atomics.load",
			"Atomics.load(input,other)",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BIGINT,
			true,
		],
	] as const)(
		"preserves %s result unions and their heap requirements",
		(operation, expression, mask, rooted) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,observe){const result=${expression};observe();return result;}globalThis.compute=compute;`,
				"compute",
				{ stackRoots: "precise" },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			const call = out.native.body.instructions[ip]!;
			if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing exact builtin call");
			expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([mask]);
			expect(out.native.registerRepresentations[call.dst]).toBe("boxed");
			expect(out.native.storage!.rootRegisters.includes(call.dst)).toBe(rooted);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("selects predicates independently for boxed canonical and typed Number entries", () => {
		const out = inspectStaticValueFunction(
			"function compute(input){return Number.isFinite(input);}globalThis.compute=compute;",
			"compute",
		);
		const reps = [...out.native.registerRepresentations];
		reps[0] = "number";
		const keep = (roots: ReadonlyArray<number>) => roots.filter((local) => local !== 0);
		const native = lowerNativeFunctionStorage({
			...out.native,
			directEntries: [
				{
					id: 0,
					parameterRepresentations: ["number"],
					resultRepresentation: "boolean",
					registerRepresentations: reps,
					gc: {
						safepoints: out.native.gc.safepoints.map((point) => ({
							...point,
							rootRegisters: keep(point.rootRegisters),
							incomingRootRegisters: keep(point.incomingRootRegisters),
							outgoingRootRegisters: keep(point.outgoingRootRegisters),
						})),
					},
				},
			],
		});
		expect(native.storage!.numberPredicates[0]!.mode).toBe("boxed");
		expect(native.directEntries[0]!.storage!.numberPredicates[0]!.mode).toBe("number");
		const image = {
			...out.image,
			native: {
				...out.image.native,
				functions: out.image.native.functions.map((fn) =>
					fn.functionIndex === native.functionIndex ? native : fn,
				),
			},
		};
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("validates an exact Number input certificate independently of boxed physical storage", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate,condition){const value=+input;const finite=Number.isFinite(value);gate();return condition?value:finite;}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.storage!.numberPredicates[0]!.instructionIp;
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CALL_KNOWN") throw new Error("Missing predicate");
		expect(out.native.registerRepresentations[op.arguments[0]!]).toBe("boxed");
		const facts = [
			...(out.native.facts ?? new Array(out.native.instructions.length).fill(undefined)),
		];
		facts[ip] = {
			inputKindMasks: [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_NUMBER],
		};
		const native = lowerNativeFunctionStorage({ ...out.native, facts });
		expect(native.storage!.numberPredicates[0]!.mode).toBe("number");
		const image = {
			...out.image,
			native: {
				...out.image.native,
				functions: out.image.native.functions.map((fn) =>
					fn.functionIndex === native.functionIndex ? native : fn,
				),
			},
		};
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		facts[ip] = {
			inputKindMasks: [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_TOP],
		};
		expect(() => validateNativeStorage({ ...native, facts })).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it.each(["isFinite", "isInteger", "isSafeInteger"])(
		"persists Number.%s kernel modes and rejects stale choices",
		(predicate) => {
			for (const [mask, mode] of [
				[COMPILER_VALUE_KIND_TOP, "boxed"],
				[COMPILER_VALUE_KIND_NUMBER, "number"],
				[COMPILER_VALUE_KIND_NUMBER, "integer"],
				[COMPILER_VALUE_KIND_STRING, "non-number"],
			] as const) {
				const out = inspectStaticValueFunction(
					`function compute(input){return Number.${predicate}(input);}globalThis.compute=compute;`,
					"compute",
				);
				const ip = out.native.storage!.numberPredicates[0]!.instructionIp;
				const native = lowerNativeFunctionStorage({
					...out.native,
					facts: out.native.facts!.with(ip, {
						...out.native.facts![ip],
						inputKindMasks: [COMPILER_VALUE_KIND_TOP, mask],
						inputIntegerRanges:
							mode === "integer" ? [undefined, COMPILER_INT32_RANGE] : undefined,
					}),
				});
				const plan = native.storage!.numberPredicates[0]!;
				expect(plan?.mode).toBe(mode);
				const image = {
					...out.image,
					native: {
						...out.image.native,
						functions: out.image.native.functions.with(native.functionIndex, native),
					},
				};
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() =>
					validateNativeStorage({
						...native,
						storage: {
							...native.storage!,
							numberPredicates: [
								{ ...plan, mode: mode === "boxed" ? "integer" : "boxed" },
							],
						},
					}),
				).toThrow(/invalid or stale storage plan/);
				if (mode === "integer") {
					const op = native.body.instructions[plan.instructionIp]!;
					if (op.opcode !== "CALL_KNOWN") throw new Error("Missing planned predicate");
					expect(
						emitCompiledFunction(native, native.functionIndex, "", false)!.source,
					).toContain(`r${op.dst} = ${predicate === "isNaN" ? "false" : "true"};`);
				}
			}
		},
	);

	it.each([
		["Number", "Number(input)"],
		["Date.parse", "Date.parse(input)"],
		["Object.hasOwn", "Object.hasOwn(input, other)"],
		["Object.is", "Object.is(input, other)"],
		["Map.prototype.has", "Map.prototype.has.call(input, other)"],
		["Array.isArray", "Array.isArray(input, other)"],
		["ArrayBuffer.isView", "ArrayBuffer.isView(input, other)"],
		["JSON.isRawJSON", "JSON.isRawJSON(input, other)"],
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

	it("carries an IsArray result through a non-inlined function call", () => {
		const out = inspectStaticValueFunction(
			`const classify = function classify(value, observe) {
				for(let i=0;i<3;i++) observe();
				return Array.isArray(value);
			};
			function compute(value,observe){
				const result=classify(value,observe);
				observe();
				return typeof result==='boolean';
			}
			globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		const call = out.core.find(
			(op) => op.opcode === "call" && op.attributes.callResultKindMask !== undefined,
		);
		expect(call?.attributes.callResultKindMask).toBe(COMPILER_VALUE_KIND_BOOLEAN);
		expect(
			out.native.body.instructions.some((op) => op.opcode === "TYPEOF_COMPARE"),
		).toBe(false);
		expect(out.c.source).not.toContain("mal_value_is_boolean");
	});

	it.each([
		"synthetic",
		"raw storage",
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
		else if (kind === "input alias") instructions[ip] = { ...op, arguments: [op.dst] };
		else if (kind === "construct") instructions[ip] = { ...op, construct: true };
		else if (kind === "spread") instructions[ip] = { ...op, argumentMode: "array" };
		else if (kind === "heap result") instructions[ip] = { ...op, operation: "String" };
		const native = {
			...out.native,
			facts: [
				...out.native.facts!,
				...Array.from(
					{ length: instructions.length - out.native.facts!.length },
					() => undefined,
				),
			].map((fact, index) =>
				index === ip && instructions[ip] !== op ? undefined : fact,
			),
			storageValues: kind === "raw storage" ? undefined : storageValues,
			body: { ...out.native.body, instructions },
		};
		expect(lowerNativeFunctionStorage(native).storage!.rootRegisters).toContain(op.dst);
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it.each([
		["Number(input)", false],
		["input", true],
	] as const)("tracks every boxed phi writer alongside %s", (alternative, rooted) => {
		const out = inspectStaticValueFunction(
			`function compute(input,gate,condition){let value;if(condition)value=Number(input);else value=${alternative};gate();return value;}globalThis.compute=compute;`,
			"compute",
		);
		const image = boxedNativeFactContract(out.image);
		const native = image.native.functions[out.native.functionIndex]!;
		const returned = native.body.instructions.find(
			(op) => op.opcode === "RETURN" && op.value >= 0,
		);
		if (returned?.opcode !== "RETURN") throw new Error("Missing joined builtin value");
		expect(native.registerRepresentations[returned.value]).toBe("boxed");
		expect(native.storage!.rootRegisters.includes(returned.value)).toBe(rooted);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
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
