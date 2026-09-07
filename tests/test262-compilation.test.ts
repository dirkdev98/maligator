import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SyntaxDiagnostic } from "../src/compiler/frontend/syntax-diagnostic.ts";
import { compileTest262ProgramImage } from "../src/test262/compile.ts";
import { extractFrontmatterFromSource } from "../src/test262/files.ts";
import { test262CompileNegativeVerdict } from "../src/test262/policy.ts";
import type { Test262File, Test262Frontmatter } from "../src/test262/types.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-compile-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function file(content: string, frontmatter: Test262Frontmatter = {}): Test262File {
	return { path: "entry.js", content, frontmatter, result: "UNKNOWN" };
}

describe("Test262 compilation semantics", () => {
	it("retains original source while reading raw metadata", () => {
		const source = '#!"use strict"\r\n/*---\nflags: [raw]\n---*/\nwith ({}) {}';
		const extracted = extractFrontmatterFromSource("raw.js", source);
		expect(extracted.frontmatter.flags).toEqual(["raw"]);
		expect(extracted.source).toBe(source);
		expect(
			compileTest262ProgramImage(file(extracted.source, extracted.frontmatter), false)
				.image,
		).toBeDefined();
	});

	it("does not credit entry parse failures as module resolution failures", () => {
		const result = compileTest262ProgramImage(
			file("export const = 1;", {
				flags: ["module"],
				negative: { phase: "resolution", type: "SyntaxError" },
			}),
			true,
			directory,
		);
		expect(result.result).toBe("COMPILE_FAILED");
		expect(result.failure).toContain("got parse SyntaxError");
	});

	it("attributes invalid imported source to module resolution", () => {
		writeFileSync(path.join(directory, "invalid.js"), "export const = 1;");
		const result = compileTest262ProgramImage(
			file('import "./invalid.js";', {
				flags: ["module"],
				negative: { phase: "resolution", type: "SyntaxError" },
			}),
			true,
			directory,
		);
		expect(result.result).toBe("PASSED");
	});

	it("does not credit a missing export as an entry parse failure", () => {
		writeFileSync(path.join(directory, "empty.js"), "export {};");
		const result = compileTest262ProgramImage(
			file('import { missing } from "./empty.js";', {
				flags: ["module"],
				negative: { phase: "parse", type: "SyntaxError" },
			}),
			true,
			directory,
		);
		expect(result.result).toBe("COMPILE_FAILED");
		expect(result.failure).toContain("got resolution SyntaxError");
	});

	it("rejects wrong exception types and unclassified compiler errors", () => {
		const negative = file("", {
			negative: { phase: "parse", type: "TypeError" },
		});
		expect(
			test262CompileNegativeVerdict(negative, new SyntaxDiagnostic("parse", "invalid"))
				?.passed,
		).toBe(false);
		negative.frontmatter.negative!.type = "SyntaxError";
		expect(
			test262CompileNegativeVerdict(negative, new SyntaxError("compiler bug"))?.passed,
		).toBe(false);
	});

	it("preserves sloppy script parsing through the dynamic-import graph", () => {
		writeFileSync(path.join(directory, "dependency.js"), "export const value = 1;");
		const input = file('with ({}) { import("./dependency.js"); }', {
			features: ["dynamic-import"],
			flags: ["noStrict"],
		});
		expect(compileTest262ProgramImage(input, false, directory).image).toBeDefined();
		expect(compileTest262ProgramImage(input, true, directory).result).toBe(
			"COMPILE_FAILED",
		);
	});
});
