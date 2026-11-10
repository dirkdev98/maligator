import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/error-constructor-roots.js";
const output = mkdtempSync(path.join(os.tmpdir(), "mal-error-roots-"));
let expected: string;
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;

beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "error-constructor-roots",
		outDir: output,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: {
				eval: false,
				realms: false,
				intl: { enabled: false },
			},
			surface: { node: false, webPlatform: false },
		}),
	});
});

afterAll(() => rmSync(output, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"keeps error construction alive across collecting callbacks with %s execution",
	(backend) => {
		for (const env of [{ MAL_HOST_GC: "1" }, { ...STRESS_ENV, MAL_HOST_GC: "1" }]) {
			expect(runToStdout(pair[backend], { env, timeoutMs: 30_000 })).toBe(expected);
		}
	},
	120_000,
);
