import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

function compileAndCompare(fixture: string) {
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-unreachable-method-bodies-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "unreachable-method-bodies",
			config: resolveBuildConfig({}),
			outDir,
		});
		expect(runToStdout(pair.compiled)).toBe(expected);
		expect(runToStdout(pair.interpreted)).toBe(expected);
		return pair.programImage.runtime;
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

it("preserves the identities of class methods whose bodies cannot run", () => {
	const { functions, stringConstants } = compileAndCompare(
		"tests/local/unreachable-method-bodies.mjs",
	);
	const strings = stringConstants.map((units) => String.fromCharCode(...units));
	const byName = new Map(functions.map((fn) => [strings[fn.nameStringIndex], fn]));
	for (const [name, length] of [
		["dormant", 2],
		["dormantGenerator", 0],
		["dormantAsync", 0],
	] as const) {
		expect(byName.get(name)?.length).toBe(length);
		expect(byName.get(name)?.instructions).toEqual([{ opcode: "UNREACHABLE_METHOD" }]);
	}
	expect(byName.has("dormantClosure")).toBe(false);
	expect(strings).not.toContain("dormant body literal");
});

it("keeps host reads of a method made enumerable by a Proxy descriptor trap", () => {
	compileAndCompare("tests/local/proxy-method-descriptor.mjs");
});
