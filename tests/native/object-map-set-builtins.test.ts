import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildBackendPairFromOneDefinition,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-map-set-builtins.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-map-set-builtins-"));

describe("Object Map and Set builtins", () => {
	let lockedCompiled: string;
	let lockedInterpreted: string;
	let mutableCompiled: string;

	beforeAll(() => {
		const locked = buildBackendPairFromOneDefinition({
			fixture,
			name: "object-map-set-builtins-locked",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		lockedCompiled = locked.compiled;
		lockedInterpreted = locked.interpreted;
		mutableCompiled = buildNativeBinary({
			fixture,
			name: "object-map-set-builtins-mutable",
			outDir,
			compiled: true,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
	}, 600_000);

	it("preserves locked compiled and interpreted semantics", () => {
		for (const binary of [lockedCompiled, lockedInterpreted]) {
			const output = runToStdout(binary, { env: { MAL_HOST_GC: "1" } });
			assertResultPass(output);
			expect(output).toContain("MODE locked");
		}
	});

	it("retains mutable primordial fallbacks", () => {
		const output = runToStdout(mutableCompiled, { env: { MAL_HOST_GC: "1" } });
		assertResultPass(output);
		expect(output).toContain("MODE mutable");
	});

	it("keeps reflection grouping and collection values live under GC stress", () => {
		for (const binary of [lockedCompiled, lockedInterpreted]) {
			const output = runToStdout(binary, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				timeoutMs: 60_000,
			});
			assertResultPass(output);
		}
	});
});
