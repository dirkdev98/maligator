import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypointToBuffer } from "../src/compile-program.ts";

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
	test("allows disabled-feature usage when no build config is supplied", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint('eval("1 + 1"); /a/.test("a");')),
		).not.toThrow();
	});

	test("rejects eval when a resolved config disables it", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint('eval("1 + 1");'), {
				buildConfig: resolveBuildConfig({ engine: { eval: false } }),
			}),
		).toThrow(/engine\.eval is false/);
	});

	test("rejects RegExp when a resolved config disables it", () => {
		expect(() =>
			compileEntrypointToBuffer(entrypoint("const pattern = /a/;"), {
				buildConfig: resolveBuildConfig({ engine: { regexp: false } }),
			}),
		).toThrow(/engine\.regexp is false/);
	});
});
