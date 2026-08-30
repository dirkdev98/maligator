import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../src/compiler/pipeline/compile-program.ts";
import { serializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";

const directories: Array<string> = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function entrypoint(source: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "maligator-policy-"));
	directories.push(directory);
	const entry = path.join(directory, "entry.js");
	writeFileSync(entry, source);
	return entry;
}

describe("compileEntrypoint build policy", () => {
	test("reports the complete on-disk compiler phase order", () => {
		const phases: Array<string> = [];
		const definition = compileEntrypoint(entrypoint("const answer = 40 + 2;"), {
			runPhase: (phase, run) => {
				phases.push(phase);
				return run();
			},
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
		expect(phases).toEqual([
			"graph",
			"semantic",
			"construct core ir",
			"core ir optimizations",
			"lower core ir",
			"lower to vm",
		]);
	});

	test("reports serialization after the complete wire compiler pipeline", () => {
		const phases: Array<string> = [];
		const bytes = compileEntrypointToBuffer(entrypoint("const answer = 40 + 2;"), {
			runPhase: (phase, run) => {
				phases.push(phase);
				return run();
			},
		});

		expect(bytes.length).toBeGreaterThan(0);
		expect(phases).toEqual([
			"graph",
			"semantic",
			"construct core ir",
			"core ir optimizations",
			"lower core ir",
			"lower to vm",
			"serialize",
		]);
	});

	test("keeps the portable image independent of native direct-entry planning", () => {
		const entry = entrypoint(`
			function format(left, right, scale) {
				let total = 0;
				for (let index = 0; index < 10; index++) total += scale * index;
				return String(left) + String(right) + total;
			}
			console.log(format({}, {}, 3));
		`);
		const options = { buildConfig: resolveBuildConfig({}) };
		const portable = compileEntrypointToBuffer(entry, options);
		const native = compileEntrypoint(entry, options);

		expect(native.native.functions.some((fn) => fn.directEntries.length > 0)).toBe(true);
		expect(portable).toEqual(serializeRuntimeImage(native.runtime));
	});

	test("allows disabled-feature usage when no build config is supplied", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint('eval("1 + 1"); /a/.test("a");')),
		).not.toThrow();
	});

	test("compiles eval when disabled so the runtime gate can throw on execution", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint('eval("1 + 1");'), {
				buildConfig: resolveBuildConfig({ engine: { eval: false } }),
			}),
		).not.toThrow();
	});

	test("rejects eval in compile-check mode", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint('eval("1 + 1");'), {
				buildConfig: resolveBuildConfig({ engine: { eval: "compile-check" } }),
			}),
		).toThrow(/engine\.eval is "compile-check"/);
	});

	test("rejects RegExp when a resolved config disables it", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint("const pattern = /a/;"), {
				buildConfig: resolveBuildConfig({ engine: { regexp: false } }),
			}),
		).toThrow(/engine\.regexp is false/);
	});
});
