import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/known-reentry.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-known-reentry-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each([false, true])("captured predicates with realms=%s", (realms) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `known-reentry-${realms}`,
			outDir,
			nativeStackRoots: "precise",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms, eval: false },
			}),
		});
	});
	for (const method of ["isNaN", "isFinite", "isInteger", "isSafeInteger"])
		it.each([
			"values",
			"replace",
			"delete",
			"global",
			"throw",
			"accessor",
			"extra",
			"noncallable",
		])(`${method} preserves %s observations`, (scenario) => {
			const env = {
				REENTRY_METHOD: method,
				REENTRY_CASE: scenario,
				REENTRY_FAMILY: realms ? "unary" : "number",
				MAL_HOST_GC: "1",
			};
			const reference = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(reference);
		});
});
it("retains predicate specialization in a statically initialized interpreted image", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/known-reentry-c-image.js",
		name: "known-reentry-c-image",
		outDir,
		compiled: false,
		mainFile: "runtime/test262_main.c",
		nativeStackRoots: "precise",
		config: resolveBuildConfig({
			engine: { primordials: "mutable", realms: false, eval: false },
		}),
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("known-reentry-c-image PASS\n");
});
