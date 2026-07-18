import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-proxy-own-property-"));
const HOST_GC = { MAL_HOST_GC: "1" };

describe("Proxy own-property internal methods", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/proxy_own_property.js",
			name: "proxy-own-property-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/proxy_own_property.js",
			name: "proxy-own-property-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled and interpreted", () => {
		assertResultPass(runToStdout(compiled, { env: HOST_GC }));
		assertResultPass(runToStdout(interpreted, { env: HOST_GC }));
	});

	it("passes compiled and interpreted under GC stress", () => {
		const env = { ...HOST_GC, ...STRESS_ENV };
		assertResultPass(runToStdout(compiled, { env }));
		assertResultPass(runToStdout(interpreted, { env }));
	});
});
