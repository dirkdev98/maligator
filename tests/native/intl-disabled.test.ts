import { mkdtempSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// `engine.intl: false`: no ICU crates, no `Intl` global. The fixture asserts Intl
// is absent and the locale-sensitive methods (localeCompare / toLocaleString) use
// the locale-insensitive fallbacks. Builds its own archives (the intl-off C +
// ICU-less Rust archives are not the ones globalSetup prebuilt), so no
// skipRuntimeBuild.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-intl-off-"));

describe("engine.intl: false", () => {
	let intlOffBin: string;
	beforeAll(() => {
		intlOffBin = buildNativeBinary({
			fixture: "tests/local/intl_disabled.js",
			name: "intl-disabled",
			mainFile: HOST_MAIN,
			outDir,
			intlEnabled: false,
		});
	});

	it("Intl absent + locale-insensitive fallbacks", () => {
		assertResultPass(runToStdout(intlOffBin));
	});

	it("holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(intlOffBin, { env: STRESS_ENV }));
	});

	it("drops the ICU baked data (much smaller than the Intl-on binary)", () => {
		const intlOnBin = buildNativeBinary({
			fixture: "tests/local/intl_disabled.js",
			name: "intl-enabled",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true, // Intl-on archives were prebuilt by globalSetup
		});
		const offSize = statSync(intlOffBin).size;
		const onSize = statSync(intlOnBin).size;
		// ICU's baked CLDR is ~9-10 MB; allow generous slack for linker differences.
		expect(onSize - offSize).toBeGreaterThan(5_000_000);
	});
});
