import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { parseCliArgs } from "../../src/cli.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { hostExecutionTarget, resolveExecution } from "../../src/platform/execution.ts";
import type { HarnessExecutionInvocation } from "../../src/test-harness.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-platform-execution-"));
const config = resolveBuildConfig({ engine: { primordials: "mutable", regexp: false } });
const command = parseCliArgs(["test", "--repeat", "2", "--shuffle", "42"]);
if (command.kind !== "test") throw new Error("Expected test command");
const target = hostExecutionTarget(process.platform, process.arch);
const snapshots = [false, true].map((compiled) =>
	resolveExecution(command, config, { compiled, optimization: "full", target }),
);
const invocations: Array<HarnessExecutionInvocation> = [];
let runner: string;
let deadBinary: string;

beforeAll(() => {
	const derivation = buildDerivationFromConfig(config);
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({ features: derivation.features }),
		false,
		derivation.cacheSuffix,
	).binaryPath;
	for (const snapshot of snapshots) {
		const image = compileEntrypoint(path.resolve("tests/local/platform-execution.mjs"), {
			buildConfig: config,
			execution: snapshot,
		});
		if (snapshot.compiled) {
			invocations.push({
				executable: buildNativeProgramImage(image, {
					name: "execution-compiled",
					config,
					mainFile: HOST_MAIN,
					outDir: root,
				}),
				args: [],
			});
		} else {
			const wire = path.join(root, "execution-interpreted.malw");
			writeFileSync(wire, serializeRuntimeImage(image.runtime));
			invocations.push({ executable: runner, args: [wire] });
		}
	}
	const deadImage = compileEntrypoint(path.join(root, "dead.mjs"), {
		entryGoal: "module",
		entrySource:
			'import { execution } from "maligator:process"; if (!execution.compiled) throw new Error("wrong backend"); console.log("DEAD_IMPORT_OK");',
		buildConfig: config,
		execution: snapshots[1],
	});
	deadBinary = buildNativeProgramImage(deadImage, {
		name: "execution-unused",
		compiled: true,
		config,
		mainFile: HOST_MAIN,
		outDir: root,
	});
}, 300_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("prepared platform execution data", () => {
	it("excludes the native installer when its export is eliminated", () => {
		const result = spawnSync(deadBinary, [], { encoding: "utf8", timeout: 30_000 });
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain("DEAD_IMPORT_OK");
		const symbols = spawnSync("nm", [deadBinary], { encoding: "utf8", timeout: 30_000 });
		expect(symbols.status, symbols.stderr).toBe(0);
		expect(symbols.stdout).not.toContain("mal_host_install_maligator_process");
	});
	it.each([false, true])(
		"preserves identity, shape and deep immutability with GC stress=%s",
		(stress) => {
			for (const [index, invocation] of invocations.entries()) {
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 30_000,
					env: { ...process.env, ...(stress ? STRESS_ENV : {}) },
				});
				expect(result.signal, result.stderr).toBeNull();
				expect(result.status, result.stderr || result.stdout).toBe(0);
				const line = result.stdout
					.split("\n")
					.find((entry) => entry.startsWith("SNAPSHOT "));
				expect(line).toBeDefined();
				expect(JSON.parse(line!.slice("SNAPSHOT ".length))).toEqual(snapshots[index]);
			}
		},
	);

	it("shares a snapshot across wires while keeping host and application contexts separate", () => {
		const sources = [
			'import { execution } from "maligator:process"; globalThis.first = execution; JSON.parse = () => { throw new Error("patched JSON.parse"); }; Object.freeze = () => { throw new Error("patched Object.freeze"); };',
			'import { execution } from "maligator:process"; import * as namespace from "maligator:process"; const dynamic = await import("maligator:process"); if (namespace !== dynamic || execution !== globalThis.first) throw new Error("fragment identity changed"); globalThis.second = execution;',
			'import { execution } from "maligator:process"; if (execution === globalThis.first || !Object.isFrozen(execution.config.engine)) throw new Error("application context leaked"); console.log("CONTEXTS " + execution.command + "/" + globalThis.first.command);',
		];
		const dev = parseCliArgs(["dev"]);
		if (dev.kind !== "dev") throw new Error("Expected dev command");
		const separate = resolveExecution(dev, config, {
			compiled: false,
			optimization: "development",
			target,
		});
		const wires = sources.map((entrySource, index) => {
			const image = compileEntrypoint(path.join(root, `fragment-${index}.mjs`), {
				entrySource,
				entryGoal: "module",
				buildConfig: config,
				execution: index === 2 ? separate : snapshots[0],
			});
			const wire = path.join(root, `fragment-${index}.wire`);
			writeFileSync(wire, serializeRuntimeImage(image.runtime));
			return wire;
		});
		const result = spawnSync(
			runner,
			[
				"--maligator-internal-run-wires",
				String(wires.length),
				path.join(root, "entry.mjs"),
				...wires,
			],
			{ encoding: "utf8", timeout: 30_000, env: { ...process.env, ...STRESS_ENV } },
		);
		expect(result.signal, result.stderr).toBeNull();
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain("CONTEXTS dev/test");
	});
});
