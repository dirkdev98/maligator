import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	CRYPTO_START_FAILURE_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// Transient `crypto.argon2` start failures reach the callback instead of
// throwing. The two conditions that produce one — no worker available, and a
// full queue — are host states the default pool never reaches, so the driver
// stands up a one-worker, one-slot pool with a slow derivation and arms a single
// empty pool start. Maligator-only: Node's pool has neither seam.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-start-failure-"));

describe("node:crypto argon2 start failures (surface.node)", () => {
	let compiled: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-crypto-start-failure.mjs",
			name: "node-crypto-start-failure",
			mainFile: CRYPTO_START_FAILURE_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("delivers worker-unavailable and saturated starts through the callback", () => {
		assertResultPass(runToStdout(compiled));
	});

	// The failure state is linked and posted before the drain, so a collection in
	// that window must still find the callback through the module's root source.
	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});
});
