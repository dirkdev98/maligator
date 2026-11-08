import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/ordinary-constructor-capacity.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-ordinary-constructor-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("ordinary constructor storage capacity", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves property publication and constructor calls under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `ordinary-constructor-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
			});
			for (const name of ["Pair", "Constrained"]) {
				const constructor = pair.programImage.runtime.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
						) === name,
				);
				expect(constructor?.isClassConstructor).toBe(false);
				expect(constructor?.constructorSlotReserve).toBe(2);
			}
			for (const binary of [pair.compiled, pair.interpreted]) {
				for (const stress of [{}, STRESS_ENV]) {
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
				}
			}
		},
	);
});
