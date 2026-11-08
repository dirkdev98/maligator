import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeDirectEntry } from "../src/compiler/target/program-image.ts";
import { computeArgumentRetentionLimit } from "../src/compiler/target/runtime-image.ts";

function compile(source: string, primordials: "mutable" | "locked" = "mutable") {
	const text = `globalThis.read = ${source};`;
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			text,
			"/arguments.js",
			parseScript(text, { strict: false }),
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}

const read = 'function read(key) { "use strict"; return arguments[key]; }';

describe.each(["mutable", "locked"] as const)(
	"incoming argument reads with %s primordials",
	(primordials) => {
		it.each([
			[read, true],
			[
				"function read() { let value; const args = arguments; for(let i=0;i<args.length;i++) value=args[i]; return value; }",
				true,
			],
			["function read(key) { key=0; return arguments[key]; }", false],
			["function* read(key) { yield arguments[key]; }", false],
			["async function read(key) { return arguments[key]; }", false],
		] as const)("keeps the frame eligibility boundary for %s", (source, eligible) => {
			const image = compile(source, primordials);
			expect(
				image.runtime.functions[1]!.instructions.some(
					(op) => op.opcode === "LOAD_DYNAMIC_ARGUMENT",
				),
			).toBe(eligible);
		});
	},
);

it("retains the incoming slice through a dynamic read's artifact roundtrip", () => {
	const image = deserializeCompilerArtifact(serializeCompilerArtifact(compile(read)));
	const owner = image.runtime.functions[1]!;
	expect(owner.instructions.some((op) => op.opcode === "LOAD_DYNAMIC_ARGUMENT")).toBe(
		true,
	);
	expect(owner.needsArguments).toBe(true);
	expect(computeArgumentRetentionLimit(owner)).toBe(0x7fffffff);
	expect(
		owner.instructions
			.slice(0, owner.argumentSnapshotCount)
			.some((op) => op.opcode === "LOAD_DYNAMIC_ARGUMENT"),
	).toBe(false);
});

it("rejects a direct entry without the dynamic read's incoming slice", () => {
	const native = compile(read).native.functions[1]!;
	const op = native.body.instructions.find((op) => op.opcode === "LOAD_DYNAMIC_ARGUMENT");
	if (op === undefined) throw new Error("Missing dynamic argument read");
	expect(() =>
		validateNativeDirectEntry(
			{ ...native.body, instructions: [op] },
			{
				id: 0,
				parameterRepresentations: Array.from(
					{ length: native.body.parameterCount },
					() => "boxed" as const,
				),
				argumentRepresentations: Array.from(
					{ length: native.body.parameterCount },
					() => "boxed" as const,
				),
				resultRepresentation: "boxed",
				registerRepresentations: native.registerRepresentations,
				gc: native.gc,
			},
		),
	).toThrow(/general argument slice/);
});
