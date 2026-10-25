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
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";

function compile(key: string, primordials: "mutable" | "locked", profile = false) {
	const path = "/property-key-flow.mjs";
	const source = `function inspect(flag,value,observe){
	for(let i=0;i<2;i++)observe(i);
	const key=flag!==flag?observe():${JSON.stringify(key)};
	return {[key]:value};}
	globalThis.inspect=inspect;
	const rows=[];
	for(let i=0;i<4;i++)rows.push(inspect('string',globalThis.value,globalThis.observe));
	rows.push(inspect(NaN,globalThis.value,globalThis.observe));
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

describe("literal property keys on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"uses constant String keys through copies and coercion under %s primordials",
		(primordials) => {
			for (const key of ["field", "", "__proto__", "01", "4294967295", "𝌆"]) {
				const original = compile(key, primordials);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const fn = inspect(image),
						entry = fn.directEntries.find(
							(e) => e.parameterRepresentations[0] === "string",
						)!;
					expect(entry, key).toBeDefined();
					expect(fn.storage!.literalPropertyDefinitions, key).toEqual([]);
					const [plan] = entry.storage!.literalPropertyDefinitions;
					expect(plan, key).toBeDefined();
					expect(
						String.fromCharCode(...image.runtime.stringConstants[plan!.stringIndex]!),
					).toBe(key);
					expect(fn.body.instructions[plan!.instructionIp]!.opcode).toBe(
						"DEFINE_PROPERTY",
					);
					expect(() =>
						validateNativeProgramStorage(image.native, image.runtime.stringConstants),
					).not.toThrow();
					expect(() => emitProgramImage(image)).not.toThrow();
				}
			}
		},
	);
	it("retains the indexed definition path for proven Array index strings", () => {
		for (const key of ["0", "1", "4294967294"]) {
			const image = compile(key, "locked"),
				fn = inspect(image);
			for (const storage of [fn.storage!, ...fn.directEntries.map((e) => e.storage!)])
				expect(storage.literalPropertyDefinitions, key).toEqual([]);
		}
	});
	it("retains original instructions and profile observations", () => {
		const image = compile("field", "locked", true),
			fn = inspect(image);
		expect(fn.body.profileSiteIds).toBeDefined();
		expect(fn.body.instructions.some((op) => op.opcode === "TO_PROPERTY_KEY")).toBe(true);
		expect(() => emitProgramImage(image)).not.toThrow();
	});
});
