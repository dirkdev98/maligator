import { execFileSync } from "node:child_process";
import { beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/captured-number-cells.mjs";
let binaries: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;

beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	binaries = buildBackendPairFromOneProgramImage({
		fixture,
		name: "captured-number-cells",
		evalEnabled: false,
	});
});

it.each(["compiled", "interpreted"] as const)(
	"matches Node for captured counters, overflow, TDZ reads and cells that leave Number (%s)",
	(backend) => {
		expect(runToStdout(binaries[backend])).toBe(expected);
	},
);

it.each(["compiled", "interpreted"] as const)(
	"keeps captured counters intact under GC stress (%s)",
	(backend) => {
		expect(runToStdout(binaries[backend], { env: STRESS_ENV, timeoutMs: 60000 })).toBe(
			expected,
		);
	},
);
