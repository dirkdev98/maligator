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
import { selectNativeArrayInitializations } from "../src/compiler/target/native-array-initialization.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { decodeVmValueOperand } from "../src/compiler/target/runtime-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.classify=function(source,escape,observe){${body}};`,
			"/split-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
describe("fresh Array initialization regions", () => {
	it.each(["mutable", "locked"] as const)(
		"initializes prepared values under %s primordials",
		(mode) => {
			const image = compile("return [source,escape,observe];", mode);
			expect(
				image.native.functions[1]!.storage!.arrayInitializations[0]!.values,
			).toHaveLength(3);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("consumes the existing folded push sequence", () => {
		const image = compile(
			"const result=[];result.push(source);result.push(escape);result.push(observe);return result;",
			"locked",
		);
		expect(image.native.functions[1]!.storage!.arrayInitializations).toHaveLength(1);
	});
	it.each(["mutable", "locked"] as const)(
		"prepares proven numeric and Boolean producers before allocation under %s primordials",
		(mode) => {
			const image = compile(
				"source=+source;escape=+escape;return [source+1,escape*2,source<escape,observe];",
				mode,
			);
			const native = image.native.functions[1]!;
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
		const native = image.native.functions[1]!;
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
	it("rejects initialization moved across effects or holes", () => {
		for (const body of [
			"return [observe(),source,escape];",
			"return [source,,escape];",
			"return [source+1,escape*2,observe];",
			"source=+source;return [source+1,observe(),escape];",
			"source=+source;return [source+1,observe.value,escape];",
			"source=+source;return [source+1,escape?source*2:source*3,observe];",
			"source=+source;return [source+1,,escape];",
		]) {
			expect(compile(body).native.functions[1]!.storage!.arrayInitializations).toEqual(
				[],
			);
		}
	});
	it("invalidates a prepared key overwritten by the array allocation", () => {
		const image = compile("return [source,escape];");
		const native = image.native.functions[1]!;
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
			native = image.native.functions[1]!;
		const plan = native.storage!.arrayInitializations[0]!;
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							arrayInitializations: [{ ...plan, values: plan.values.slice(1) }],
						},
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
