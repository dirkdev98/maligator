import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/eval-private-bootstrap.cjs";
const cases = ["direct", "indirect", "function", "script"].flatMap((kind) =>
	[
		"plain",
		"sealed",
		"accessor",
		"readonly",
		"clone-accessor",
		"clone-readonly",
		"bare-sealed",
	].map((protection) => ({ kind, protection })),
);
describe("private compiler bootstrap", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-eval-private-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "eval-private",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: true, realms: true },
			}),
		});
	});
	it.each(cases)(
		"preserves cold and warm $kind compilation with $protection globals",
		({ kind, protection }) => {
			const selection = {
				EVAL_BOOTSTRAP_KIND: kind,
				EVAL_BOOTSTRAP_PROTECTION: protection,
			};
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...selection },
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...env, ...selection } })).toBe(expected);
		},
	);

	it("compiles eval in an application without a process global", () => {
		const leanFixture = join(outDir, "lean.mjs");
		writeFileSync(
			leanFixture,
			`console.log(eval("const name = 'process'; [6 * 7, typeof globalThis[name]].join(' ')"));`,
		);
		const binaries = buildBackendPairFromOneProgramImage({
			fixture: leanFixture,
			name: "eval-lean",
			outDir,
			config: resolveBuildConfig({ engine: { eval: true } }),
		});
		for (const binary of [binaries.compiled, binaries.interpreted]) {
			expect(runToStdout(binary)).toBe("42 undefined\n");
		}
	});
});
