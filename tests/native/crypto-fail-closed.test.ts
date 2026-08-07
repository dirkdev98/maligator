import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

// The two surfaces that used to succeed where they should have refused:
// tls.connect silently dropping options it does not implement, and
// getRandomValues accepting a view with no live backing store.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-crypto-fail-closed-"));

describe("crypto surfaces fail closed", () => {
	let tlsOptions: string;
	let getRandomValues: string;
	beforeAll(() => {
		tlsOptions = buildNativeBinary({
			fixture: "tests/local/node-tls-options.mjs",
			name: "node-tls-options",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		getRandomValues = buildNativeBinary({
			fixture: "tests/local/web-crypto-get-random-values.mjs",
			name: "web-crypto-get-random-values",
			mainFile: HOST_MAIN,
			outDir,
		});
	}, 600_000);

	it("refuses tls.connect options it does not implement", () => {
		assertResultPass(runToStdout(tlsOptions));
	});

	it("refuses getRandomValues over detached and out-of-bounds views", () => {
		assertResultPass(runToStdout(getRandomValues));
	});
});
