import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each(["mutable", "locked"] as const)(
	"preserves boxed writer facts and materialized fields with %s primordials",
	(primordials) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-stack-field-facts-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/stack-field-facts.mjs",
				name: `stack-field-facts-${primordials}`,
				mainFile: HOST_MAIN,
				outDir,
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
			});
			for (const [name, representation] of [
				["numberField", "number"],
				["booleanField", "boolean"],
				["stringField", "string"],
			] as const) {
				const native = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(native.registerRepresentations[0], name).toBe("boxed");
				expect(
					native.storage!.stackObjects.some(
						(site) => site.slotRepresentations[0] === representation,
					),
					name,
				).toBe(true);
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
					assertExactLines(runToStdout(binary, { env }), ["stack-field-facts PASS"]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
);
