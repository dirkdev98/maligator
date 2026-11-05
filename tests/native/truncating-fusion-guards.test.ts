import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/truncating-fusion-guards.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-truncating-fusion-guards-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function selectsTruncatingPair(image: ProgramImage, name: string): boolean {
	const native = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === name,
	);
	return (
		native?.specializations.some(
			(region) =>
				region.kind === "numeric-fusion" &&
				region.representation === "binary-pairs-truncating-i32",
		) ?? false
	);
}

describe("truncating fusion over unproved Numbers", () => {
	it("matches Node for doubles, wrapping sums and coercive operands", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "truncating-fusion-guards",
			outDir,
			mainFile: HOST_MAIN,
			nativeStackRoots: "precise",
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
		});
		for (const name of [
			"hashElements",
			"mixElements",
			"shiftTrunc",
			"powerPlusOne",
			"productOr",
		])
			expect(selectsTruncatingPair(pair.programImage, name), name).toBe(true);
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	}, 600000);
});
