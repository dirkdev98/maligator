import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { selectNativeArrayInitializations } from "../src/compiler/target/native-array-initialization.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { decodeVmValueOperand } from "../src/compiler/target/runtime-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.classify=function classify(source,escape,observe){${body}};`,
			"/array-initialization.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
function classify(image: ReturnType<typeof compile>) {
	const native = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "classify",
	);
	if (native === undefined) throw new Error("Missing classify function");
	return native;
}

describe("fresh Array initialization regions", () => {
	it.each(["mutable", "locked"] as const)(
		"prepares immutable BigInt values after handlers and in catch bodies under %s primordials",
		(mode) => {
			for (const body of [
				'try{observe();}catch(error){escape(error);}return [source,123456789012345678901234567890n,"tag",null,undefined,true,0n,escape,source];',
				'try{observe();}catch(error){return [source,error,123456789012345678901234567890n,"tag",null];}',
				'return [source,123456789012345678901234567890n,"tag",null];',
			]) {
				const image = compile(body, mode);
				const native = classify(image);
				const [plan] = native.storage!.arrayInitializations;
				expect(plan, body).toBeDefined();
				const constants = native.body.instructions.flatMap((op, ip) =>
					op.opcode === "CREATE_BIGINT" ? [ip] : [],
				);
				expect(constants.length).toBeGreaterThan(0);
				expect(constants.every((ip) => ip < plan!.allocationIp)).toBe(true);
				const facts = analyzeNativeBodyFacts(native.body);
				expect(
					plan!.stores.every(
						(ip) => facts.handlerTargets[ip] === facts.handlerTargets[plan!.allocationIp],
					),
				).toBe(true);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image, {})).not.toThrow();
			}
		},
	);
	it("keeps incremental values outside protected ranges and preserves hole fallback", () => {
		for (const body of [
			'try{return [source,123n,"tag"]; }catch(error){return error;}',
			'try{return [source,123n,"tag"]; }finally{observe();}',
			'try{observe();}catch(error){escape(error);}return [source,123n,,"tag"];',
		])
			expect(classify(compile(body)).storage!.arrayInitializations, body).toEqual([]);
		for (const body of [
			"try{observe();}catch(error){escape(error);}return [source,observe(),123n];",
			'try{observe();}catch(error){escape(error);}return [source,source+123n,"tag"];',
		])
			expect(classify(compile(body)).storage!.arrayInitializations[0]?.mode, body).toBe(
				"incremental",
			);
	});
	it("requires one effective handler through prepared keys, allocation, and all stores", () => {
		const image = compile("source=+source;return [source+1,escape,observe];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		const handlerIp = native.body.instructions.length - 1;
		for (const [startIp, endIp, admitted] of [
			[0, handlerIp, true],
			[plan.allocationIp, handlerIp, false],
			[plan.stores[0]!, handlerIp, false],
			[0, plan.stores.at(-1)!, false],
		] as const) {
			const body = {
				...native.body,
				handlers: [{ startIp, endIp, handlerIp }],
			};
			const selected = selectNativeArrayInitializations(
				{ ...native, body },
				analyzeNativeBodyFacts(body),
				image.runtime.stringConstants,
				() => false,
			);
			expect(selected, `${startIp}:${endIp}`).toEqual(admitted ? [plan] : []);
		}
	});
	it("rejects external entries into a protected initialization range", () => {
		const image = compile("return [source,escape,observe];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		const body = {
			...native.body,
			handlers: [{ startIp: 0, endIp: 1, handlerIp: plan.stores[1]! }],
		};
		expect(
			selectNativeArrayInitializations(
				{ ...native, body },
				analyzeNativeBodyFacts(body),
				image.runtime.stringConstants,
				() => false,
			),
		).toEqual([]);
	});
	it("rejects an incremental Array observable from an exceptional successor", () => {
		const image = compile("return [observe(),observe()];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		expect(plan.mode).toBe("incremental");
		const allocation = native.body.instructions[plan.allocationIp]!;
		if (allocation.opcode !== "CREATE_ARRAY") throw new Error("Missing allocation");
		const handlerIp = native.body.instructions.length;
		const body = {
			...native.body,
			instructions: [
				...native.body.instructions,
				{ opcode: "RETURN", value: allocation.dst } as const,
			],
			handlers: [{ startIp: 0, endIp: handlerIp, handlerIp }],
		};
		expect(
			selectNativeArrayInitializations(
				{ ...native, body },
				analyzeNativeBodyFacts(body),
				image.runtime.stringConstants,
				() => false,
			),
		).toEqual([]);
	});
	it("rejects aliases and calls that observe an incomplete incremental Array", () => {
		const image = compile("return [observe(),observe()];");
		const native = classify(image);
		const allocationIp = native.storage!.arrayInitializations[0]!.allocationIp;
		const allocation = native.body.instructions[allocationIp]!;
		if (allocation.opcode !== "CREATE_ARRAY") throw new Error("Missing allocation");
		for (const inserted of [
			{ opcode: "MOVE", dst: 0, src: allocation.dst },
			{
				opcode: "CALL",
				dst: 0,
				callee: 2,
				thisValue: -1,
				argumentCount: 1,
				arguments: [allocation.dst],
			},
		] satisfies ReadonlyArray<BytecodeInstruction>) {
			const body = {
				...native.body,
				instructions: native.body.instructions.toSpliced(allocationIp + 1, 0, inserted),
			};
			expect(
				selectNativeArrayInitializations(
					{ ...native, body },
					analyzeNativeBodyFacts(body),
					image.runtime.stringConstants,
					() => false,
				),
			).toEqual([]);
		}
	});
	it("independently rejects a forged initialization mode", () => {
		const image = compile("return [source,escape,observe];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		expect(() =>
			validateNativeStorage(native, undefined, image.runtime.stringConstants),
		).not.toThrow();
		expect(() =>
			validateNativeStorage({
				...native,
				storage: {
					...native.storage!,
					arrayInitializations: [{ ...plan, mode: "incremental" }],
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
	it("independently rejects a transported plan after its handler boundary changes", () => {
		const image = compile("return [source,escape,observe];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		const handlerIp = native.body.instructions.length - 1;
		expect(() =>
			validateNativeStorage(
				{
					...native,
					body: {
						...native.body,
						handlers: [{ startIp: plan.stores[0]!, endIp: handlerIp, handlerIp }],
					},
				},
				undefined,
				image.runtime.stringConstants,
			),
		).toThrow(/invalid or stale storage plan/);
	});
	it.each(["mutable", "locked"] as const)(
		"initializes prepared values under %s primordials",
		(mode) => {
			const image = compile("return [source,escape,observe];", mode);
			expect(classify(image).storage!.arrayInitializations[0]!.values).toHaveLength(3);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it.each(["mutable", "locked"] as const)(
		"prepares larger numeric arrays and mixed immutable literals under %s primordials",
		(mode) => {
			for (const length of [9, 16, 32]) {
				for (const values of [
					Array.from({ length }, () => "source"),
					Array.from({ length }, (_, index) => `source+${index}`),
					Array.from(
						{ length },
						(_, index) =>
							["source", '"tag"', "null", "undefined", "true", "escape"][index % 6]!,
					),
				]) {
					const image = compile(`source=+source;return [${values.join(",")}];`, mode);
					const native = classify(image);
					expect(
						native.storage!.arrayInitializations[0]?.values,
						values.join(","),
					).toHaveLength(length);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
					expect(() => emitProgramImage(image, {})).not.toThrow();
				}
			}
			const mixed = compile('return [source,"tag",null,undefined,true];', mode);
			expect(classify(mixed).storage!.arrayInitializations[0]?.values).toHaveLength(5);
		},
	);
	it("keeps prepared references live through allocation and roots the completed array", () => {
		const image = compile(
			'return [source,"tag",null,undefined,true,escape,source,"last",observe];',
		);
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		expect(plan.values).toHaveLength(9);
		const allocation = native.body.instructions[plan.allocationIp]!;
		if (allocation.opcode !== "CREATE_ARRAY") throw new Error("Missing allocation");
		const point = native.gc.safepoints.find(
			(point) => point.instructionIp === plan.allocationIp,
		)!;
		for (const value of [plan.values[0], plan.values[5], plan.values[8]])
			expect(point.incomingRootRegisters).toContain(value);
		expect(point.outgoingRootRegisters).toContain(allocation.dst);
	});
	it.each(["mutable", "locked"] as const)(
		"keeps effectful values at their original stores under %s primordials",
		(mode) => {
			for (const body of [
				'return [source,"tag",null,observe(),undefined,true];',
				'return [source,"tag",null,observe.value,undefined,true];',
				'return [source+1,"tag",null,undefined,true];',
			]) {
				const image = compile(body, mode),
					native = classify(image);
				const plan = native.storage!.arrayInitializations[0]!;
				expect(plan?.mode, body).toBe("incremental");
				const facts = analyzeNativeBodyFacts(native.body);
				for (const point of native.gc.safepoints.filter(
					(point) =>
						point.instructionIp > plan.allocationIp &&
						point.instructionIp < plan.stores.at(-1)!,
				)) {
					const allocation = native.body.instructions[plan.allocationIp]!;
					if (allocation.opcode !== "CREATE_ARRAY")
						throw new Error("Missing Array allocation");
					expect(point.incomingRootRegisters, body).toContain(allocation.dst);
				}
				expect(
					plan.stores.every(
						(ip) => facts.handlerTargets[ip] === facts.handlerTargets[plan.allocationIp],
					),
				).toBe(true);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image, {})).not.toThrow();
			}
		},
	);
	it.each([33, 64, 128])(
		"reserves %i prepared elements without a larger temporary value array",
		(length) => {
			const image = compile(
				`return [${Array.from({ length }, () => "source").join(",")}];`,
			);
			const plan = classify(image).storage!.arrayInitializations[0]!;
			expect(plan?.mode).toBe("incremental");
			expect(plan.values).toHaveLength(length);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("rejects holes and oversized initialization", () => {
		for (const body of [
			'return [source,"tag",,undefined,true];',
			`return [${Array.from({ length: 129 }, () => "source").join(",")}];`,
		])
			expect(classify(compile(body)).storage!.arrayInitializations).toEqual([]);
	});
	it("consumes the existing folded push sequence", () => {
		const image = compile(
			"const result=[];result.push(source);result.push(escape);result.push(observe);return result;",
			"locked",
		);
		expect(classify(image).storage!.arrayInitializations).toHaveLength(1);
	});
	it.each(["mutable", "locked"] as const)(
		"prepares proven numeric and Boolean producers before allocation under %s primordials",
		(mode) => {
			const image = compile(
				"source=+source;escape=+escape;return [source+1,escape*2,source<escape,observe];",
				mode,
			);
			const native = classify(image);
			const [plan] = native.storage!.arrayInitializations;
			expect(plan?.values).toHaveLength(4);
			const arithmetic = native.body.instructions.flatMap((op, ip) =>
				op.opcode === "BINARY" ? [ip] : [],
			);
			expect(arithmetic).toHaveLength(3);
			expect(arithmetic.every((ip) => ip < plan!.allocationIp)).toBe(true);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("declines prepared keys overwritten or reached across a block boundary", () => {
		const image = compile("source=+source;return [source+1,escape,observe];");
		const native = classify(image);
		const [plan] = native.storage!.arrayInitializations;
		expect(plan).toBeDefined();
		const firstStore = native.body.instructions[plan!.stores[0]!]!;
		if (firstStore.opcode !== "DEFINE_PROPERTY") throw new Error("Missing initializer");
		const key = decodeVmValueOperand(firstStore.key);
		if (key.kind !== "register") throw new Error("Expected a prepared key register");
		for (const inserted of [
			{ opcode: "MOVE", dst: key.register, src: 0 },
			{ opcode: "JUMP", targetIp: plan!.allocationIp + 1 },
		] satisfies ReadonlyArray<BytecodeInstruction>) {
			const body = {
				...native.body,
				instructions: native.body.instructions.toSpliced(plan!.allocationIp, 0, inserted),
			};
			expect(
				selectNativeArrayInitializations(
					{ ...native, body },
					analyzeNativeBodyFacts(body),
					image.runtime.stringConstants,
					() => false,
				),
			).toEqual([]);
		}
	});
	it("does not move effectful values and declines branch joins and holes", () => {
		for (const body of [
			"return [observe(),source,escape];",
			"return [source,,escape];",
			"return [source+1,escape*2,observe];",
			"source=+source;return [source+1,observe(),escape];",
			"source=+source;return [source+1,observe.value,escape];",
			"source=+source;return [source+1,escape?source*2:source*3,observe];",
			"source=+source;return [source+1,,escape];",
		]) {
			const plans = classify(compile(body)).storage!.arrayInitializations;
			if (body.includes(",,") || body.includes("?")) expect(plans, body).toEqual([]);
			else expect(plans[0]?.mode, body).toBe("incremental");
		}
	});
	it("does not decode unrelated large string literals while discovering prepared keys", () => {
		const image = compile(
			`return [source,${JSON.stringify("x".repeat(150000))},null,undefined,true];`,
		);
		expect(classify(image).storage!.arrayInitializations[0]?.values).toHaveLength(5);
	});
	it("declines prepared keys outside the bounded reaching-definition window", () => {
		const image = compile("source=+source;return [source+1,escape,observe];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		const body = {
			...native.body,
			instructions: native.body.instructions.toSpliced(
				plan.allocationIp,
				0,
				...Array.from({ length: 129 }, (): BytecodeInstruction => ({
					opcode: "MOVE",
					dst: 0,
					src: 0,
				})),
			),
		};
		expect(
			selectNativeArrayInitializations(
				{ ...native, body },
				analyzeNativeBodyFacts(body),
				image.runtime.stringConstants,
				() => false,
			),
		).toEqual([]);
	});
	it("invalidates a prepared key overwritten by the array allocation", () => {
		const image = compile("return [source,escape];");
		const native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		const allocation = native.body.instructions[plan.allocationIp]!;
		if (allocation.opcode !== "CREATE_ARRAY") throw new Error("Missing allocation");
		const body = {
			...native.body,
			instructions: native.body.instructions
				.map((op, ip) =>
					ip === plan.stores[0] && op.opcode === "DEFINE_PROPERTY"
						? { ...op, key: allocation.dst }
						: op,
				)
				.toSpliced(plan.allocationIp, 0, {
					opcode: "CREATE_NUMBER",
					dst: allocation.dst,
					value: 0,
				}),
		};
		expect(
			selectNativeArrayInitializations(
				{ ...native, body },
				analyzeNativeBodyFacts(body),
				image.runtime.stringConstants,
				() => false,
			),
		).toEqual([]);
	});
	it("rejects forged initialization inputs", () => {
		const image = compile("return [source,escape,observe];"),
			native = classify(image);
		const plan = native.storage!.arrayInitializations[0]!;
		for (const values of [plan.values.slice(1), [...plan.values].reverse()])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(
							image.native.functions.indexOf(native),
							{
								...native,
								storage: {
									...native.storage!,
									arrayInitializations: [{ ...plan, values }],
								},
							},
						),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
