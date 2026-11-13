import { spawnSync } from "node:child_process";
import { beforeAll, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { prebuiltCompilerBake, STRESS_ENV } from "../../src/test-harness.ts";

let runner: string;
beforeAll(() => {
	const config = resolveBuildConfig({ surface: { node: true }, engine: { eval: true } });
	const derivation = buildDerivationFromConfig(config);
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({
			features: derivation.features,
			compilerBake: prebuiltCompilerBake(),
		}),
		false,
		derivation.cacheSuffix,
	).binaryPath;
});

function evaluate(args: Array<string>, env: NodeJS.ProcessEnv = {}) {
	return spawnSync(runner, args, {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, MAL_GC_AT_EXIT: "1", ...env },
	});
}

it.each(["-e", "--eval"])("evaluates nonempty Unicode source with %s", (option) => {
	const result = evaluate([option, 'console.log("evaluated 🦎", 6 * 7)']);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("evaluated 🦎 42\n");
});

it("accepts an empty script", () => {
	const result = evaluate(["-e", ""]);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("");
});

it("keeps execution options out of process.argv", () => {
	const source =
		"console.log(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }))";
	const result = evaluate(["--eval", source, "--", "two words", "--argument"]);
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		argv: ["two words", "--argument"],
		execArgv: ["--eval", source],
	});
});

it("drains promises and timers under GC stress", () => {
	const result = evaluate(
		[
			"-e",
			'Promise.resolve().then(() => console.log("microtask")); setTimeout(() => console.log("timer"), 1);',
		],
		STRESS_ENV,
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("microtask\ntimer\n");
});

it("returns the explicit process exit status", () => {
	const result = evaluate(["-e", "process.exit(7)"]);
	expect(result.status, result.stderr).toBe(7);
});

it.each([
	["const = 1", "SyntaxError"],
	['throw new Error("evaluation failed")', "evaluation failed"],
])("reports evaluation failures for %s", (source, error) => {
	const result = evaluate(["-e", source]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(error);
});

it.each([["-e"], ["--input-type=module", "-e", "0"], ["-e", "0", "--unsupported"]])(
	"rejects unsupported or incomplete options %s",
	(...args) => {
		const result = evaluate(args);
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/requires a script argument|unsupported development runtime option/,
		);
	},
);
