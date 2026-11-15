import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/open-const-captures.cjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-open-const-captures-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["conservative", "precise"] as const)(
	"source-immutable captures with runtime eval and %s roots",
	(nativeStackRoots) => {
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		beforeAll(() => {
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `open-const-captures-${nativeStackRoots}`,
				nativeStackRoots,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms: true },
					surface: { node: true },
				}),
			});
		});

		it("copies initialized const leaves despite unrelated dynamic scope", () => {
			const factory = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "immutableFactory",
			);
			expect(factory?.storage?.captures.copiedClosureIps.length).toBeGreaterThan(0);
		});

		it.each([
			["retained", "retains distinct scalar and heap values after their owners return"],
			["mixed", "preserves copies when siblings materialize shared mutable storage"],
			["mutable", "shares mutable bindings between readers and writers"],
			["uninitialized", "keeps temporal dead zones before const initialization"],
			["eval", "preserves eval writes and const assignment rejection"],
			["with", "keeps dynamic object bindings live in escaped closures"],
			["loop", "retains a separate value for each iteration scope"],
			["initialization", "preserves effectful initialization and thrown identity"],
			["self", "preserves an immutable named self binding in sloppy code"],
		] as const)("%s: %s", (scenario, _behavior) => {
			const env = { OPEN_CAPTURE_CASE: scenario };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env })).toBe(expected);
				expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
			}
		});
	},
);
