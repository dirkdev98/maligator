import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

const fixture = "tests/local/captured-prefix-inlining.cjs";

function compile(source: string): ProgramImage {
	const entry = "/captured-prefix-inlining.cjs";
	const facts = compilerProgramFactsFromConfig(
		resolveBuildConfig({ engine: { eval: false, realms: false, primordials: "locked" } }),
	);
	return compileSemanticProgramToProgramImage(
		runSemanticAnalysisForGraph(buildModuleGraph(entry, { entrySource: source })),
		{
			facts: withProgramClosure(
				facts,
				programClosureCertificate({ kind: "whole-program", entry }, [], []),
			),
			coreVerification: "per-pass",
		},
	);
}

function namedProbes(image: ProgramImage, functionName: string): ReadonlyArray<string> {
	const { functions, stringConstants } = image.runtime;
	const string = (index: number) =>
		String.fromCharCode(...(stringConstants[index] ?? []));
	const fn = functions.find((fn) => string(fn.nameStringIndex) === functionName);
	expect(fn, functionName).toBeDefined();
	return fn!.instructions.flatMap((instruction) =>
		instruction.opcode === "PROBE_READ" && instruction.readKind === "named"
			? [string(instruction.stringIndex)]
			: [],
	);
}

describe("captured prefix inline admission", () => {
	it("expands two callers and keeps the original callee for both fallbacks", () => {
		const image = compile(readFileSync(fixture, "utf8"));
		for (const caller of ["visit", "visitAgain", "visitSelected"]) {
			expect(namedProbes(image, caller)).toEqual(
				expect.arrayContaining(["keys", "length"]),
			);
		}
		expect(namedProbes(image, "consume")).toEqual([]);
	});

	it.each([
		["arguments", "const keys = layer.keys; if (!keys) return done(arguments.length);"],
		[
			"early closure creation",
			"const keys = layer.keys; saved.push(() => keys); if (!keys) return done();",
		],
		[
			"direct recursion",
			"const keys = layer.keys; if (!keys) return done(); if (keys.length > 2) return consume({ keys: null }, done);",
		],
		["unproved user call", "const keys = layer.readKeys(); if (!keys) return done();"],
	])("keeps the original call when the prefix uses %s", (_reason, prefix) => {
		const image = compile(`
			"use strict";
			const saved = [];
			function consume(layer, done) {
				${prefix}
				saved.push(() => keys);
				return done(keys);
			}
			function visit(input, seed) { return consume(input, (value) => value || seed); }
			globalThis.visitCapturedPrefix = visit;
		`);
		expect(namedProbes(image, "visit")).toEqual([]);
	});
});
