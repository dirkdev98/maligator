import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeStringSpan } from "../src/compiler/target/native-string-span.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
function config(primordials: "mutable" | "locked") {
	return resolveBuildConfig({
		engine: { primordials, eval: false, realms: false },
		surface: { node: true },
	});
}
function compile(body: string, mode: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect=function inspect(source,radix){${body}};`,
			"span-parse.js",
		),
		{ facts: compilerProgramFactsFromConfig(config(mode)) },
	);
}
function named(image: ReturnType<typeof compile>, name: string) {
	return image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === name,
	)!;
}
describe("shared span numeric parsers", () => {
	it.each(["mutable", "locked"] as const)(
		"selects both parsers for every bundled span source under %s primordials",
		(mode) => {
			const buildConfig = config(mode);
			const image = compileSemanticProgramToProgramImage(
				loadEntrypointAndRunSemanticAnalysis(
					resolve("tests/local/string-span-parsers.js"),
					{ buildConfig, stripTypes: stripCompactTypes },
				),
				{ facts: compilerProgramFactsFromConfig(buildConfig) },
			);
			for (const name of [
				"parseRange",
				"parseSplit",
				"parseCapture",
				"parseNested",
				"parseBounded",
			]) {
				const fn = named(image, name);
				const kinds = [
					...fn.specializations.flatMap((r) =>
						r.kind === "string-span" ? r.consumers : [],
					),
					...fn.storage!.spanContinuations.flatMap((p) => p.consumers),
				].map((c) => c.kind);
				expect(kinds, name).toEqual(expect.arrayContaining(["parseInt", "parseFloat"]));
				expect(
					emitCompiledFunction(fn, fn.functionIndex, "", false)!.source,
					name,
				).toContain("mal_builtin_number_span_parse");
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each(["mutable", "locked"] as const)(
		"retains captured aliases and declines parsing a span as radix under %s",
		(mode) => {
			const image = compile(
				"const integer=Number.parseInt;const floating=parseFloat;const part=source.slice(1,-1);return [integer(part,radix),floating(part),part.length];",
				mode,
			);
			const fn = named(image, "inspect"),
				region = fn.specializations.find((r) => r.kind === "string-span")!;
			expect(region?.consumers.map((c) => c.kind)).toEqual(
				expect.arrayContaining(["parseInt", "parseFloat"]),
			);
			const rejected = compile(
				"const part=source.slice(1,-1);return parseInt(part,part);",
				mode,
			);
			expect(
				named(rejected, "inspect")
					.specializations.flatMap((r) => (r.kind === "string-span" ? r.consumers : []))
					.some((c) => c.kind === "parseInt"),
			).toBe(false);
		},
	);
	it("rejects a forged same-arity parser and a continuation consumer independently", () => {
		const image = compile(
			"const part=source.slice(1,-1);return [parseFloat(part),part.length];",
		);
		const fn = named(image, "inspect"),
			region = fn.specializations.find((r) => r.kind === "string-span")!;
		const forged = {
			...region,
			consumers: region.consumers.map((c) =>
				c.kind === "parseFloat" ? { ...c, kind: "parseInt" as const } : c,
			),
		};
		expect(() =>
			validateNativeStringSpan(
				fn.body.instructions,
				forged,
				image.runtime.stringConstants,
				fn.body.handlers,
			),
		).toThrow(/string-span/);
		const projected = compile(
			'const part=source.split("|")[1];return [parseFloat(part),part.length];',
		);
		const owner = named(projected, "inspect");
		expect(
			owner.storage!.spanContinuations.some((p) =>
				p.consumers.some((c) => c.kind === "parseFloat"),
			),
		).toBe(true);
		const storage = {
			...owner.storage!,
			spanContinuations: owner.storage!.spanContinuations.map((p) => ({
				...p,
				consumers: p.consumers.map((c) =>
					c.kind === "parseFloat" ? { ...c, kind: "parseInt" as const } : c,
				),
			})),
		};
		expect(() =>
			serializeCompilerArtifact({
				...projected,
				native: {
					...projected.native,
					functions: projected.native.functions.map((f) =>
						f === owner ? { ...f, storage } : f,
					),
				},
			}),
		).toThrow(/storage|continuation/i);
	});

	it("independently rejects forged parser identity, arity and argument role", () => {
		const image = compile(
			"const part=source.slice(1,-1);return [parseInt(part,radix),part.length];",
		);
		const fn = named(image, "inspect"),
			region = fn.specializations.find((r) => r.kind === "string-span")!;
		const consumer = region.consumers.find((c) => c.kind === "parseInt")!;
		const forged = {
			...region,
			consumers: region.consumers.map((c) =>
				c === consumer ? { ...c, kind: "parseFloat" as const } : c,
			),
		};
		expect(() =>
			validateNativeStringSpan(
				fn.body.instructions,
				forged,
				image.runtime.stringConstants,
				fn.body.handlers,
			),
		).toThrow(/string-span/);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.map((f) =>
						f !== fn
							? f
							: {
									...f,
									specializations: fn.specializations.map((r) =>
										r === region ? forged : r,
									),
									regionActions: vmRegionActions(
										fn.specializations.map((r) => (r === region ? forged : r)),
									),
								},
					),
				},
			}),
		).toThrow(/string-span/);
		const call = fn.body.instructions[consumer.ip]!;
		if (call.opcode !== "CALL") throw new Error("Expected captured parse call");
		for (const arguments_ of [
			[],
			[call.arguments[1]!, consumer.value],
			[consumer.value, call.arguments[1]!, call.arguments[1]!],
		])
			expect(() =>
				validateNativeStringSpan(
					fn.body.instructions.with(consumer.ip, { ...call, arguments: arguments_ }),
					region,
					image.runtime.stringConstants,
					fn.body.handlers,
				),
			).toThrow(/string-span/);
	});
});
