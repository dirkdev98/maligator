import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
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

const arithmetic = Array.from(
	{ length: 20 },
	(_, index) => `(x * ${index + 1} + bias)`,
).join(" + ");

function compile(body: string, closed = true, profile = false) {
	const entry = "/local-capture-arguments.js";
	const base = compilerProgramFactsFromConfig(
		resolveBuildConfig({
			engine: { eval: false, realms: false, primordials: "locked" },
		}),
	);
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(body, entry),
		{
			facts: closed
				? withProgramClosure(
						base,
						programClosureCertificate({ kind: "whole-program", entry }, [], []),
					)
				: base,
			coreVerification: "per-pass",
			profile,
		},
	);
}

const localSource = `globalThis.run = function run(seed) {
	let bias = seed;
	const read = x => ${arithmetic};
	let sum = 0;
	for (let i = 0; i < 100; i++) { bias = (bias + 1) | 0; sum += read(i); }
	return sum;
};`;

function privateHelpers(image: ReturnType<typeof compile>) {
	return image.runtime.functions.flatMap((fn, index) =>
		fn.parameterCount === 2 && fn.length === 1
			? [{ fn, native: image.native.functions[index]! }]
			: [],
	);
}

describe("private local capture arguments", () => {
	it("connects the captured representation to typed arguments and results", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(compile(localSource)),
		);
		const helpers = privateHelpers(image);
		expect(helpers).toHaveLength(1);
		const { fn, native } = helpers[0]!;
		expect(
			fn.instructions.some((instruction) => instruction.opcode === "LOAD_CAPTURED"),
		).toBe(false);
		expect(native.directEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parameterRepresentations: ["number", "number"],
					resultRepresentation: "number",
				}),
			]),
		);
	});

	it("retains source-site profiling and artifact round trips for a lifted helper", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(compile(localSource, true, true)),
		);
		expect(privateHelpers(image)).toHaveLength(1);
	});

	it("keeps escaping closure objects on their original calling convention", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; const read = x => ${arithmetic};
			globalThis.escaped = read; return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("keeps sibling-writable bindings shared across reentrant calls", () => {
		const image = compile(`globalThis.run = seed => {
			let bias = seed; const read = x => ${arithmetic};
			globalThis.write = next => bias = next; return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it.each([
		"arguments.length + x + bias",
		"arguments[x] + bias",
		"arguments[1] + x + bias",
	])("does not expose capture arguments through %s", (expression) => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed;
			function read(x) { return ${expression}; }
			let sum = 0; for(let i = 0; i < 100; i++) sum += read(i); return sum;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("does not lift per-iteration cell identities", () => {
		const image = compile(`globalThis.run = seed => {
			let sum = 0;
			for (let bias = 0; bias < 10; bias++) {
				const read = x => ${arithmetic}; sum += read(seed);
			}
			return sum;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("keeps the generic source-visible convention without a closure certificate", () => {
		expect(privateHelpers(compile(localSource, false))).toHaveLength(0);
	});
});
