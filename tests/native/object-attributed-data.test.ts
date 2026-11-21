import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-attributed-data.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-object-attributed-data-"));
const environments = [
	{},
	...(["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some((name) => process.env[name] === "1")
		? []
		: [STRESS_ENV]),
];
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let binaries: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture,
		name: "object-attributed-data",
		outDir,
	});
});

describe.each(["compiled", "interpreted"] as const)(
	"attributed data in %s code",
	(backend) => {
		it.each([
			["descriptors", "preserves every data descriptor attribute combination"],
			["compatibility", "rejects incompatible nonconfigurable updates"],
			["enumeration", "filters nonenumerable fields across enumeration and copying"],
			["caches", "rejects readonly writes after polymorphic loads"],
			["prototype", "invalidates child append caches for inherited readonly properties"],
			["transitions", "preserves order and flags across fallback transitions"],
			[
				"growth",
				"retains heap values and private fields through growth and integrity changes",
			],
			["reentry", "observes descriptor side effects before choosing storage"],
		] as const)("%s: %s", (scenario, _behavior) => {
			const env = { ATTRIBUTED_DATA_CASE: scenario, MAL_HOST_GC: "1" };
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const gc of environments)
				expect(runToStdout(binaries[backend], { env: { ...env, ...gc } })).toBe(expected);
		});
	},
);
