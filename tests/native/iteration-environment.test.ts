import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/iteration-environment.js";

describe("per-iteration callback environments", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "iteration-environment",
			config: resolveBuildConfig({}),
		});
	});

	it.each(["compiled", "interpreted"] as const)(
		"preserves closure snapshots, identity and abrupt completion in the %s backend",
		(backend) => {
			expect(runToStdout(pair[backend], { env: STRESS_ENV })).toBe(expected);
		},
	);
});
