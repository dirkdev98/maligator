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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-url-search-params-iterator-"));
const HOST_GC = { MAL_HOST_GC: "1" };

describe("URLSearchParams live iterators", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/url_search_params_iterator.js",
			name: "url-search-params-iterator-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/url_search_params_iterator.js",
			name: "url-search-params-iterator-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled with host GC", () => {
		assertResultPass(runToStdout(compiled, { env: HOST_GC }));
	});

	it("passes compiled under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: { ...HOST_GC, ...STRESS_ENV } }));
	});

	it("passes interpreted with host GC", () => {
		assertResultPass(runToStdout(interpreted, { env: HOST_GC }));
	});

	it("passes interpreted under GC stress", () => {
		assertResultPass(runToStdout(interpreted, { env: { ...HOST_GC, ...STRESS_ENV } }));
	});
});
