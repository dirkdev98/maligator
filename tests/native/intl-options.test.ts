import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-intl-options-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/intl-option-protocol.js",
		name: "intl-option-protocol",
		mainFile: HOST_MAIN,
		outDir,
		intlFeatures: [
			"collator",
			"number-format",
			"date-time-format",
			"plural-rules",
			"list-format",
		],
	});
});

it.each(["compiled", "interpreted"] as const)(
	"observes Intl option validation and collecting coercions with %s execution",
	(backend) => {
		expect(runToStdout(pair[backend], { env: { MAL_HOST_GC: "1" } }).trim()).toBe("ok");
		expect(
			runToStdout(pair[backend], { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } }).trim(),
		).toBe("ok");
	},
);
