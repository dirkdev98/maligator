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

const outDir = mkdtempSync(join(tmpdir(), "mal-http-hostname-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-http-hostname.cjs",
		name: "http-hostname",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"resolves HTTP and HTTPS listeners and cancels pending lookups in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend])).toContain("HTTP HOSTNAME PASS");
	},
);

it.each(["compiled", "interpreted"] as const)(
	"retains pending listeners, TLS configuration and async context under GC stress in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend], { env: STRESS_ENV })).toContain(
			"HTTP HOSTNAME PASS",
		);
	},
);
