import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("keeps getter effects and closure identity across a re-entered captured prefix", () => {
	const fixture = "tests/local/captured-prefix-inlining.cjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "captured-prefix-inline",
		config: resolveBuildConfig({
			engine: {
				primordials: "locked",
				eval: false,
				realms: false,
				intl: { enabled: false },
			},
		}),
	});
	const { functions, stringConstants } = pair.programImage.runtime;
	const visit = functions.find(
		(fn) =>
			String.fromCharCode(...(stringConstants[fn.nameStringIndex] ?? [])) === "visit",
	);
	expect(
		visit?.instructions.some(
			(op) => op.opcode === "PROBE_READ" && op.readKind === "named",
		),
	).toBe(true);
	for (const target of [pair.compiled, pair.interpreted]) {
		expect(runToStdout(target)).toBe(expected);
		expect(runToStdout(target, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
	}
});
