import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixtures = {
	commonjs: "tests/local/node-computed-builtin.cjs",
	created: "tests/local/node-computed-create-require.mjs",
	selective: "tests/local/node-link-cjs-computed.cjs",
	eval: "tests/local/node-computed-builtin-eval.cjs",
	literal: "tests/local/node-literal-builtin.mjs",
};
const outDir = mkdtempSync(join(tmpdir(), "mal-node-computed-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const binaries = new Map<string, { compiled: string; interpreted: string }>();
function run(binary: string, args: Array<string>, env: NodeJS.ProcessEnv): string {
	const invocation = resolveHarnessExecutionInvocation(binary);
	return execFileSync(invocation.executable, [...invocation.args, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30000,
	});
}
function compare(name: keyof typeof fixtures, args: Array<string>) {
	const expected = execFileSync(
		process.execPath,
		["--no-warnings", fixtures[name], ...args],
		{
			encoding: "utf8",
		},
	);
	const pair = binaries.get(name)!;
	const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
		(key) => process.env[key] === "1",
	);
	for (const binary of [pair.compiled, pair.interpreted])
		for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
			expect(run(binary, args, env)).toBe(expected);
}
describe("computed native builtin require", () => {
	beforeAll(() => {
		for (const [name, fixture] of Object.entries(fixtures))
			binaries.set(
				name,
				buildBackendPairFromOneProgramImage({
					fixture,
					name: `computed-${name}`,
					outDir,
					config: resolveBuildConfig({
						engine: {
							primordials: "mutable",
							eval: name === "eval",
							intl: { enabled: false },
						},
					}),
				}),
			);
	});
	it.each(["os", "node:os", "node:assert/strict", "node:sqlite"])(
		"loads a fresh %s through CommonJS and shares the builtin cache",
		(id) => compare("commonjs", [id]),
	);
	it.each(["os", "node:os", "node:assert/strict", "node:sqlite"])(
		"loads a fresh %s through createRequire and shares the builtin cache",
		(id) => compare("created", [id]),
	);
	it("loads a computed builtin without a process global", () => compare("selective", []));
	it("keeps the loader when eval exposes the wrapper require", () =>
		compare("eval", ["node:os"]));
	it("loads literal getBuiltinModule names without the builtin loader", () =>
		compare("literal", []));
});
