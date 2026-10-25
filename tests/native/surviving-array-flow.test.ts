import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each(["mutable", "locked"] as const)(
	"preserves projected Array initializers, effects and fallback under %s primordials",
	(primordials) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-surviving-array-"));
		try {
			const fixture = "tests/local/surviving-array-flow.mjs";
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `surviving-array-${primordials}`,
				outDir: directory,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				nativeStackRoots: "precise",
			});
			for (const name of [
				"conditionalFirst",
				"conditionalLast",
				"conditionalBoth",
				"liveInitializer",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				const entry = fn.directEntries.find(
					(e) => e.parameterRepresentations[0] === "string",
				)!;
				expect(entry, name).toBeDefined();
				expect(fn.storage!.arrayInitializations, name).toEqual([]);
				expect(entry.storage!.arrayInitializations[0]?.mode, name).toBe("incremental");
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_PRIMORDIALS: primordials, MAL_HOST_GC: "1", ...stress },
							timeoutMs: 120000,
						}),
					).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
