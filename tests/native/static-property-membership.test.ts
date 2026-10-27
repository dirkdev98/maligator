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

const fixtures = [
	{
		name: "membership",
		fixture: "tests/local/static-property-membership.mjs",
		optimized: [
			"symbolRead",
			"cellSymbolRead",
			"registryCellRead",
			"capturedCellRead",
		].map((functionName) => ({ functionName, forbidden: ["LOAD_PROPERTY"] })),
	},
	{
		name: "joined key bounds",
		fixture: "tests/local/joined-object-key-bounds.mjs",
		optimized: [
			...["joinedMissing", "joinedDescriptor"].map((functionName) => ({
				functionName,
				forbidden: ["CALL", "CALL_KNOWN", "CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			})),
			{
				functionName: "joinedEffects",
				forbidden: ["CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			},
		],
	},
];
it.each(
	fixtures.flatMap((fixture) =>
		(["mutable", "locked"] as const).map((primordials) => ({ ...fixture, primordials })),
	),
)(
	"preserves $name with $primordials primordials",
	({ fixture, name, optimized, primordials }) => {
		const environment = { MAL_PRIMORDIALS: primordials };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...environment },
		});
		const directory = mkdtempSync(join(tmpdir(), "mal-static-membership-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name,
				mainFile: HOST_MAIN,
				outDir: directory,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				nativeStackRoots: "precise",
			});
			if (primordials === "locked") {
				for (const { functionName, forbidden } of optimized) {
					const index = pair.programImage.runtime.functions.findIndex(
						(fn) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
							) === functionName,
					);
					expect(index).toBeGreaterThanOrEqual(0);
					expect(
						pair.programImage.runtime.functions[index]!.instructions.some((instruction) =>
							forbidden.includes(instruction.opcode),
						),
					).toBe(false);
				}
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
