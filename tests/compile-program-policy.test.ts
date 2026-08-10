import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint, compileEntrypointToBuffer } from "../src/compile-program.ts";

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

		expect(definition.functions.length).toBeGreaterThan(0);
		expect(phases).toEqual([
			"graph",
			"semantic",
			"compile to ir",
			"ir optimizations",
			"register allocation",
			"lower to vm",
		]);
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
