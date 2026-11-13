import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-rsa-generation-"));
let binaries: { compiled: string; interpreted: string };
let nodePrivateKey: string;
beforeAll(() => {
	nodePrivateKey = generateKeyPairSync("rsa", {
		modulusLength: 1024,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-crypto-rsa-generation.mjs",
		name: "rsa-generation",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["compiled", "interpreted"] as const)(
	"RSA generation in %s code",
	(backend) => {
		it.each(["sync", "async", "invalid", "node-import"])(
			"handles %s generation",
			(selection) => {
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binaries[backend], {
							env: {
								...stress,
								MAL_TEST_RSA_CASE: selection,
								MAL_TEST_RSA_NODE_PRIVATE: nodePrivateKey,
							},
							timeoutMs: 30_000,
						}),
					).toContain("RSA GENERATION PASS");
			},
		);
	},
);
