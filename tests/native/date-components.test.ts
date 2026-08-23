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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-date-components-"));

describe("Date component projection", () => {
	let lockedCompiledUtc: string;
	let lockedInterpretedUtc: string;
	let mutableCompiledUtc: string;
	let amsterdam: string;
	let lockedCompiled: string;

	beforeAll(() => {
		const locked = buildBackendPairFromOneDefinition({
			fixture: "tests/local/date-components.js",
			name: "date-components-locked",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		lockedCompiled = locked.compiled;
		const mutable = buildNativeBinary({
			fixture: "tests/local/date-components.js",
			name: "date-components-mutable",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
		lockedCompiledUtc = runToStdout(locked.compiled, { env: { TZ: "UTC" } });
		lockedInterpretedUtc = runToStdout(locked.interpreted, { env: { TZ: "UTC" } });
		mutableCompiledUtc = runToStdout(mutable, { env: { TZ: "UTC" } });
		amsterdam = runToStdout(locked.compiled, {
			env: { TZ: "Europe/Amsterdam" },
		});
	}, 600_000);

	it("preserves exact static and component behavior in both locked backends", () => {
		for (const output of [lockedCompiledUtc, lockedInterpretedUtc]) {
			assertResultPass(output);
			expect(output).toContain("ZONE 0/0");
			expect(output).toContain("STATIC locked");
		}
	});

	it("keeps mutable Date static dispatch observable", () => {
		assertResultPass(mutableCompiledUtc);
		expect(mutableCompiledUtc).toContain("ZONE 0/0");
		expect(mutableCompiledUtc).toContain("STATIC mutable");
	});

	it("keeps coercive direct-call arguments rooted under GC stress", () => {
		assertResultPass(
			runToStdout(lockedCompiled, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1", TZ: "UTC" },
				timeoutMs: 60_000,
			}),
		);
	});

	it("keeps local renderers consistent across DST offsets", () => {
		assertResultPass(amsterdam);
		expect(amsterdam).toContain("ZONE -60/-120");
	});
});
