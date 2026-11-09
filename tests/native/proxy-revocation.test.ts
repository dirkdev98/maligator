import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mal-proxy-revocation-"));
let binaries: { compiled: string; interpreted: string };

beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/proxy-revocation.js",
		name: "proxy-revocation",
		outDir: directory,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: {
				primordials: "mutable",
				eval: false,
				realms: false,
				regexp: false,
				intl: { enabled: false },
			},
			surface: { node: false, webPlatform: false },
		}),
	});
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"retains captured Proxy slots across revocation and GC (%s)",
	(backend) => {
		expect(runToStdout(binaries[backend], { env: { MAL_HOST_GC: "1" } })).toBe(
			"proxy-revocation PASS\n",
		);
	},
);
