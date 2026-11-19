import { resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";

it("connects the declaration benchmark through exact numeric leaf entries", () => {
	const image = deserializeCompilerArtifact(
		serializeCompilerArtifact(
			compileEntrypoint(
				resolve("bench/runtime-gap/cases/connected-numeric-helpers.mjs"),
				{
					buildConfig: resolveBuildConfig({
						surface: { node: true },
						engine: { eval: false, realms: false, primordials: "locked" },
					}),
					coreVerification: "per-pass",
				},
			),
		),
	);
	const names = image.runtime.functions.map((fn) =>
		String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
	);
	const leaf = names.indexOf("leaf");
	const visitor = names.indexOf("visitor");
	const entry = image.native.functions[visitor]!.directEntries[0]!;
	expect(image.native.functions[leaf]!.directEntries).toContainEqual(
		expect.objectContaining({
			parameterRepresentations: ["number", "number"],
			resultRepresentation: "number",
		}),
	);
	expect(entry).toMatchObject({
		parameterRepresentations: ["number", "number"],
		resultRepresentation: "number",
	});
	expect(entry.callOverrides).toHaveLength(2);
	for (const call of entry.callOverrides!) {
		expect(call).toMatchObject({ functionIndex: leaf });
		expect(call.guarded).toBeUndefined();
		const genericEntry =
			image.native.functions[visitor]!.instructions[call.instructionIp];
		if (genericEntry?.kind === "call" && genericEntry.directEntryId !== undefined)
			expect(
				image.native.functions[leaf]!.directEntries[genericEntry.directEntryId]!
					.parameterRepresentations,
			).toEqual(["number", "boxed"]);
		const instruction =
			image.native.functions[visitor]!.body.instructions[call.instructionIp]!;
		expect(instruction.opcode).toBe("CALL");
		if (instruction.opcode === "CALL")
			expect(entry.registerRepresentations[instruction.dst]).toBe("number");
	}
});
