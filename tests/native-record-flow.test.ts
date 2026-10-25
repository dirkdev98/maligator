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
import { nativeControlFlowContract } from "../src/compiler/target/native-control-flow.ts";

function compile(body: string, primordials: "mutable" | "locked", profile = false) {
	const path = "/record-flow.mjs";
	const source = `function make(value){let end=0;while(end<value.length)end++;
	return {head:value+'!',end,parts:[value,end]};}
	function take(record){let sum=0;for(let i=0;i<4;i++)sum+=record.end;return sum;}
	function inspect(value,flag){${body}}
	console.log(inspect(String(globalThis.input),'string'),inspect(String(globalThis.input),NaN));`;
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

describe("record storage on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"retires dead producers and caller-owned literals under %s primordials",
		(primordials) => {
			for (const [body, kind] of [
				[
					"if(flag!==flag){let total=0;for(let i=0;i<4;i++){const record=make(value);total+=record.end;}return total;}return 0;",
					"calls",
				],
				[
					"if(flag!==flag){let total=0;for(let i=0;i<4;i++){const record={head:value,end:i,parts:[value,i]};total+=take(record);}return total;}return 0;",
					"objects",
				],
			] as const) {
				const original = compile(body, primordials);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const fn = image.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
							) === "inspect",
					)!;
					const entry = fn.directEntries.find(
						(e) => e.parameterRepresentations[1] === "string",
					)!;
					const flow = entry.storage!.controlFlow!;
					const contract = nativeControlFlowContract(
						nativeVariantContract(fn, entry),
						flow,
					);
					const sites = kind === "calls" ? fn.recordCalls! : fn.recordObjects!;
					expect(sites).toHaveLength(1);
					for (const site of sites) {
						const ip = "callIp" in site ? site.callIp : site.allocationIp;
						expect(flow.unreachableIps).toContain(ip);
					}
					expect(
						kind === "calls" ? contract.recordCalls : contract.recordObjects,
					).toEqual([]);
					expect(() =>
						validateNativeProgramStorage(image.native, image.runtime.stringConstants),
					).not.toThrow();
					expect(() => emitProgramImage(image)).not.toThrow();
				}
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"keeps live fields and projects dead consumers under %s primordials",
		(primordials) => {
			const image = compile(
				"let total=0;for(let i=0;i<4;i++){const record=make(value);if(flag!==flag)total+=record.end;total+=record.end;}return total;",
				primordials,
			);
			const fn = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "inspect",
			)!;
			const entry = fn.directEntries.find(
				(e) => e.parameterRepresentations[1] === "string",
			)!;
			const contract = nativeControlFlowContract(
				nativeVariantContract(fn, entry),
				entry.storage!.controlFlow,
			);
			expect(fn.recordCalls).toHaveLength(1);
			expect(fn.recordCalls![0]!.loads).toHaveLength(2);
			expect(contract.recordCalls).toHaveLength(1);
			expect(contract.recordCalls![0]!.loads).toHaveLength(1);
			expect(fn.recordCalls![0]!.loads).toHaveLength(2);
			expect(
				deserializeCompilerArtifact(serializeCompilerArtifact(image)).native,
			).toEqual(image.native);
		},
	);
});
