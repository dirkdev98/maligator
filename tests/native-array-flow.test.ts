import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import {
	nativeVariantContract,
	validateNativeProgramStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { selectNativeArrayInitializations } from "../src/compiler/target/native-array-initialization.ts";
import {
	analyzeNativeBodyFacts,
	projectNativeBodyFacts,
} from "../src/compiler/target/native-body-facts.ts";

function compile(body: string, primordials: "mutable" | "locked", profile = false) {
	const path = "/array-flow.mjs";
	const source = `function inspect(flag,left,right,observe){
	for(let i=0;i<2;i++)observe(i);${body}}
	globalThis.inspect=inspect;
	const rows=[];
	for(let i=0;i<4;i++)rows.push(inspect('string',globalThis.left,globalThis.right,globalThis.observe));
	rows.push(inspect(NaN,globalThis.left,globalThis.right,globalThis.observe));
	console.log(rows);`;
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, path, parseModule(source)),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials, eval: false, realms: false } }),
				),
				programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
			),
			profile,
			coreVerification: "per-pass",
		},
	);
}

function inspect(image: ReturnType<typeof compile>) {
	return image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "inspect",
	)!;
}

describe("Array initialization on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"discovers initializer stores across proven branches under %s primordials",
		(primordials) => {
			for (const body of [
				"return [flag!==flag?observe():left,right];",
				"return [left,flag!==flag?observe():right];",
				"return [flag!==flag?observe():left,observe(right)];",
				"return [flag!==flag?observe():left,flag===flag?right:observe()];",
			]) {
				const original = compile(body, primordials);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const fn = inspect(image);
					const entry = fn.directEntries.find(
						(e) => e.parameterRepresentations[0] === "string",
					)!;
					expect(entry, body).toBeDefined();
					expect(fn.storage!.arrayInitializations, body).toEqual([]);
					const [plan] = entry.storage!.arrayInitializations;
					expect(plan?.mode, body).toBe("incremental");
					expect(plan!.stores, body).toHaveLength(2);
					const flow = entry.storage!.controlFlow!;
					expect(flow.unreachableIps.length, body).toBeGreaterThan(0);
					expect(
						plan!.claimedIps.some((ip) => flow.unreachableIps.includes(ip)),
						body,
					).toBe(false);
					if (body.includes("observe(right)")) {
						const allocation = fn.body.instructions[plan!.allocationIp]!;
						if (allocation.opcode !== "CREATE_ARRAY") throw new Error("Missing Array");
						const callIp = fn.body.instructions.findIndex(
							(op, ip) =>
								ip > plan!.stores[0]! && ip < plan!.stores[1]! && op.opcode === "CALL",
						);
						expect(callIp).toBeGreaterThan(plan!.allocationIp);
						expect(flow.unreachableIps).not.toContain(callIp);
						expect(
							fn.gc.safepoints.find((point) => point.instructionIp === callIp)!
								.incomingRootRegisters,
						).toContain(allocation.dst);
					}
					expect(() =>
						validateNativeProgramStorage(image.native, image.runtime.stringConstants),
					).not.toThrow();
					expect(() => emitProgramImage(image)).not.toThrow();
				}
			}
		},
	);
	it("retains hole, handler and profiling fallbacks", () => {
		for (const [body, profile] of [
			["return [flag!==flag?observe():left,,right];", false],
			[
				"try{return [flag!==flag?observe():left,right];}catch(error){return error;}",
				false,
			],
			["return [flag!==flag?observe():left,right];", true],
		] as const) {
			const image = compile(body, "locked", profile),
				fn = inspect(image);
			for (const storage of [fn.storage!, ...fn.directEntries.map((e) => e.storage!)])
				expect(storage.arrayInitializations, body).toEqual([]);
			expect(() => emitProgramImage(image)).not.toThrow();
		}
	});
	it("does not cross independent helper entries or claimed branch sites", () => {
		const image = compile("return [flag!==flag?observe():left,right];", "locked");
		const fn = inspect(image),
			entry = fn.directEntries.find((e) => e.parameterRepresentations[0] === "string")!;
		const variant = nativeVariantContract(fn, entry),
			flow = entry.storage!.controlFlow!;
		const plan = entry.storage!.arrayInitializations[0]!;
		const branch = flow.branches.find(
			({ instructionIp }) =>
				instructionIp > plan.allocationIp && instructionIp < plan.stores[0]!,
		)!;
		expect(branch).toBeDefined();
		for (const externalEntries of [[], [plan.stores[0]!]]) {
			const body = projectNativeBodyFacts(
				variant,
				analyzeNativeBodyFacts(fn.body),
				flow,
				{
					externalEntries,
				},
			);
			expect(
				selectNativeArrayInitializations(
					variant,
					body,
					image.runtime.stringConstants,
					(ip) => externalEntries.length === 0 && ip === branch.instructionIp,
				),
			).toEqual([]);
		}
	});
});
