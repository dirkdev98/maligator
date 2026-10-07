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

const fixture = "tests/local/native-callback-discovery.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-callback-discovery-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("builtin-only callback entry discovery", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves canonical fallback and captures with %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `callback-discovery-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { eval: false, realms: false, primordials },
				}),
			});
			const transports = pair.programImage.native.functions.flatMap(
				(fn) => fn.storage!.callbackTransports,
			);
			expect(new Set(transports.map((plan) => plan.functionIndex)).size).toBe(2);
			for (const transport of transports) {
				const callback = pair.programImage.native.functions[transport.functionIndex]!;
				expect(callback.specializedOnly).not.toBe(true);
				expect(callback.directEntries).toHaveLength(1);
				expect(transport.parameters.filter((rep) => rep === "number")).toHaveLength(1);
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
		},
		600_000,
	);
});
