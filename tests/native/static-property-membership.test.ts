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
	"preserves static membership and fallback effects with %s primordials",
	(primordials) => {
		const fixture = "tests/local/static-property-membership.mjs";
		const environment = { MAL_PRIMORDIALS: primordials };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...environment },
		});
		const directory = mkdtempSync(join(tmpdir(), "mal-static-membership-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "membership",
				mainFile: HOST_MAIN,
				outDir: directory,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				nativeStackRoots: "precise",
			});
			if (primordials === "locked") {
				const index = pair.programImage.runtime.functions.findIndex(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
						) === "symbolRead",
				);
				expect(index).toBeGreaterThanOrEqual(0);
				expect(
					pair.programImage.runtime.functions[index]!.instructions.some(
						(instruction) => instruction.opcode === "LOAD_PROPERTY",
					),
				).toBe(false);
			}
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env: environment })).toBe(expected);
				expect(runToStdout(binary, { env: { ...environment, ...STRESS_ENV } })).toBe(
					expected,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	600000,
);
