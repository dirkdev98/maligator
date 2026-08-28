import { describe, expect, it } from "vitest";
import {
	compileSourceToBuffer,
	prepareSourceForCompilation,
} from "../src/compiler/pipeline/compile.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";

// The trimmed compiler entry composes parse → sema → ir → opt → regalloc →
// lower → serialize for a script source, producing a loadable wire buffer. End-
// to-end execution through the C loader is covered by scripts/eval-phase2-check.ts;
// here we check the entry composes and yields a well-formed, decodable definition.
describe("compileSourceToBuffer", () => {
	it("produces a decodable definition for a script", () => {
		const buffer = compileSourceToBuffer("const x = 1 + 2; const y = `v=${x}`;");
		const def = deserializeRuntimeImage(buffer);
		expect(def.functions.length).toBeGreaterThanOrEqual(1);
		expect(def.functions[0]!.instructions.length).toBeGreaterThan(0);
		expect(def.globalCount).toBeGreaterThan(0);
	});

	it("captures string constants used by the script", () => {
		const def = deserializeRuntimeImage(
			compileSourceToBuffer('const s = "hello world";'),
		);
		const decoder = (units: Array<number>) => String.fromCharCode(...units);
		expect(def.stringConstants.some((u) => decoder(u) === "hello world")).toBe(true);
	});

	it("emits a function per nested function", () => {
		const def = deserializeRuntimeImage(
			compileSourceToBuffer(
				"function a(){ return 1; } function b(){ return a() + 1; } b();",
			),
		);
		// Top-level + a + b.
		expect(def.functions.length).toBeGreaterThanOrEqual(3);
	});

	it("is deterministic", () => {
		const src = "let n = 0; for (let i = 0; i < 3; i++) n += i;";
		expect(Array.from(compileSourceToBuffer(src))).toEqual(
			Array.from(compileSourceToBuffer(src)),
		);
	});

	it("canonicalizes parsed empty statements before semantic lowering", () => {
		const empty = compileSourceToBuffer("", { completionValue: true });
		expect(Array.from(compileSourceToBuffer("/* comment */", { completionValue: true }))).toEqual(
			Array.from(empty),
		);
		expect(Array.from(compileSourceToBuffer("{};{{}}", { completionValue: true }))).toEqual(
			Array.from(empty),
		);
	});

	it("recognizes only a proven empty lexical grammar", () => {
		expect(prepareSourceForCompilation("{}".repeat(10_000)).semanticallyEmpty).toBe(true);
		expect(prepareSourceForCompilation("// comment\u2028 1").semanticallyEmpty).toBe(
			false,
		);
		expect(() => prepareSourceForCompilation("{")).toThrow(SyntaxError);
		expect(() => prepareSourceForCompilation("/* unterminated")).toThrow(SyntaxError);
	});
});
