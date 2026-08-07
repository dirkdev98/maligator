import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

// Math.random's seed. The generator is non-cryptographic by design, but its seed
// must not be guessable from the wall clock: a `time(nullptr)` seed made two
// processes started in the same second produce byte-identical streams, which is
// what every application-level misuse of Math.random then inherits.
//
// Both seed paths are covered, because they are different code: a program that
// links no crypto surface falls back to process/context divergence, and one that
// links node:crypto is seeded from the host CSPRNG through the registered hook.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-math-random-seed-"));

function draws(output: string): string {
	const line = output.split("\n").find((entry) => entry.startsWith("DRAWS "));
	expect(line, `no DRAWS line in:\n${output}`).toBeDefined();
	return line!.slice("DRAWS ".length);
}

describe("Math.random seeding", () => {
	let bare: string;
	let withCrypto: string;
	beforeAll(() => {
		bare = buildNativeBinary({
			fixture: "tests/local/math-random-seed.mjs",
			name: "math-random-seed-bare",
			mainFile: HOST_MAIN,
			outDir,
		});
		withCrypto = buildNativeBinary({
			fixture: "tests/local/math-random-seed-crypto.mjs",
			name: "math-random-seed-crypto",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	// The two runs are back to back, so a clock-derived seed lands in the same
	// second and repeats itself.
	it("does not repeat a stream across two runs without a crypto surface", () => {
		const first = runToStdout(bare);
		const second = runToStdout(bare);
		assertResultPass(first);
		assertResultPass(second);
		expect(draws(first)).not.toEqual(draws(second));
	});

	it("does not repeat a stream across two runs seeded by the host CSPRNG", () => {
		const first = runToStdout(withCrypto);
		const second = runToStdout(withCrypto);
		assertResultPass(first);
		assertResultPass(second);
		expect(draws(first)).not.toEqual(draws(second));
	});
});
