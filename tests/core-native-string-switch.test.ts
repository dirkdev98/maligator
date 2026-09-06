import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compileDispatch(labels: ReadonlyArray<string>, profile = false) {
	const source = `function dispatch(value) { switch (value) { ${labels.map((label, index) => `case ${JSON.stringify(label)}: return ${index};`).join(" ")} default: return -1; } } globalThis.result = dispatch(globalThis.value);`;
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "literal-dispatch.js"),
		{ profile },
	);
}

function dispatchFunction(image: ProgramImage) {
	const index = image.runtime.functions.findIndex(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			) === "dispatch",
	);
	if (index < 0) throw new Error("Missing dispatch function");
	return {
		index,
		fn: image.runtime.functions[index]!,
		native: image.native.functions[index]!,
	};
}

function emitDispatch(image: ProgramImage, relocatable = false) {
	const { index, fn, native } = dispatchFunction(image);
	return emitCompiledFunction(
		fn,
		native,
		index,
		"",
		true,
		"static",
		undefined,
		undefined,
		undefined,
		relocatable,
		undefined,
		image.runtime.stringConstants,
	)!;
}

const largeLabels = [
	"load",
	"save",
	"move",
	"jump",
	"call",
	"stop",
	"read",
	"send",
	"push",
	"pull",
];

describe("native literal string switch certificate", () => {
	it.each([
		{ labels: ["yes", "no"], strategy: "direct" },
		{ labels: ["", "a", "bb", "ccc", "dddd"], strategy: "length" },
		{ labels: largeLabels, strategy: "hash" },
	])("selects $strategy dispatch for the case distribution", ({ labels, strategy }) => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(compileDispatch(labels)),
		);
		const { native, fn } = dispatchFunction(image);
		const site = native.literalSwitches!.find((site) => site.kind === "string")!;
		expect(site.kind).toBe("string");
		if (site.kind !== "string") throw new Error("Missing string switch");
		for (const [index, label] of site.cases.entries()) {
			expect(
				String.fromCharCode(...image.runtime.stringConstants[label.stringIndex]!),
			).toBe(labels[index]);
			expect(fn.instructions[site.instructionIp + index * 3]).toMatchObject({
				opcode: "CREATE_STRING",
				stringIndex: label.stringIndex,
			});
		}
		const emitted = emitDispatch(image);
		expect(emitted.profileDecisions).toContainEqual(
			expect.objectContaining({
				code: "native-string-switch",
				outcome: "applied",
				details: { strategy, cases: labels.length },
			}),
		);
		expect(emitted.source).not.toContain("mal_ops_strict_equal_bool");
		expect(emitted.source).toContain("mal_string_equals");
	});

	it("retains generic dispatch in instrumented functions and rebases relocatable literals", () => {
		const profiled = emitDispatch(compileDispatch(largeLabels, true));
		expect(
			profiled.profileDecisions.some(
				(decision) => decision.code === "native-string-switch",
			),
		).toBe(false);
		const relocated = emitDispatch(compileDispatch(largeLabels), true);
		expect(relocated.source).toContain("__mal_relocation->string_base");
		expect(relocated.source).toContain("mal_string_hash");
	});

	it("declines mixed, effectful and over-budget cases", () => {
		for (const cases of [
			'case "a": return 1; case 2: return 2;',
			'case "a": return 1; case globalThis.effect(): return 2;',
			Array.from(
				{ length: 257 },
				(_, index) => `case "tag${index}": return ${index};`,
			).join(" "),
			`case ${JSON.stringify("a".repeat(8192))}: return 1; case "b": return 2;`,
		]) {
			const source = `function dispatch(value) { switch (value) { ${cases} default: return -1; } } globalThis.result = dispatch(globalThis.value);`;
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, "declined-switch.js"),
			);
			expect(dispatchFunction(image).native.literalSwitches).toBeUndefined();
		}
	});

	it("rejects a label that no longer matches the strict comparison chain", () => {
		const image = compileDispatch(largeLabels);
		const { native, index } = dispatchFunction(image);
		const changed = {
			...native,
			literalSwitches: native.literalSwitches!.map((site) =>
				site.kind === "number"
					? site
					: {
							...site,
							cases: site.cases.map((label, index) =>
								index === 0
									? { ...label, stringIndex: site.cases[1]!.stringIndex }
									: label,
							),
						},
			),
		};
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.map((fn, i) => (i === index ? changed : fn)),
				},
			}),
		).toThrow(/switch certificate/);
	});
});
