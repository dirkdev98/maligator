import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { developmentCompilerInstallation } from "../src/cli-commands.ts";
import { parseCliArgs } from "../src/cli.ts";
import { compilerProducerDigestsForRoot } from "../src/compiler-cache-identity.ts";
import { prepare, prepareTests } from "../src/compiler-service-worker.ts";
import { hostExecutionTarget, resolveExecution } from "../src/platform/execution.ts";

it("observes shared cancellation at the phase boundary before publishing a runtime image", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-compiler-checkpoint-"));
	try {
		const entry = path.join(directory, "entry.mts");
		const output = path.join(directory, "output.malw");
		writeFileSync(entry, "console.log(42);\n");
		const command = parseCliArgs(["build", entry, "--serialize", output]);
		if (command.kind !== "build") throw new Error("expected build command");
		const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		const flag = new Int32Array(cancellation);
		const request = {
			command,
			installation: developmentCompilerInstallation(path.resolve("src")),
			producerDigests: compilerProducerDigestsForRoot(
				path.resolve("src"),
				maligatorCacheDirectory(),
			),
			compact: true,
			invalidatedPaths: [],
			invalidateAll: false,
			cancellation,
		};
		const context = { signal: new AbortController().signal, throwIfCancelled() {} };
		expect(() =>
			prepare(
				{
					...context,
					report(phase) {
						if (phase.label === "Compile modules" && phase.state === "started")
							Atomics.store(flag, 0, 1);
					},
				},
				request,
			),
		).toThrow("Compiler task cancelled");
		expect(existsSync(output)).toBe(false);
		Atomics.store(flag, 0, 0);
		expect(prepare(context, request).serializedPath).toBe(output);
		expect(readFileSync(output).subarray(0, 4).toString()).toBe("MALW");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("compiles independent dependency islands in the requested worker processes", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-compiler-islands-"));
	try {
		writeFileSync(path.join(directory, "package.json"), `{"type":"module"}\n`);
		for (const name of ["alpha", "beta"]) {
			const packageDirectory = path.join(directory, "node_modules", name);
			mkdirSync(packageDirectory, { recursive: true });
			writeFileSync(
				path.join(packageDirectory, "package.json"),
				JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
			);
			// Fresh contents keep both islands out of the shared cache.
			writeFileSync(
				path.join(packageDirectory, "index.mjs"),
				`export const ${name} = ${JSON.stringify(randomUUID())};\n`,
			);
		}
		const entry = path.join(directory, "islands.test.mjs");
		writeFileSync(
			entry,
			`import { test } from "maligator:test";
import { alpha } from "alpha";
import { beta } from "beta";
test("islands", () => alpha + beta);
`,
		);
		const command = parseCliArgs(["test", entry]);
		if (command.kind !== "test") throw new Error("expected test command");
		const config = resolveBuildConfig({});
		const prepared = prepareTests(
			{ signal: new AbortController().signal, throwIfCancelled() {} },
			{
				input: {
					files: [entry],
					config,
					execution: resolveExecution(command, config, {
						compiled: false,
						optimization: "development",
						target: hostExecutionTarget(process.platform, process.arch),
					}),
				},
				installation: developmentCompilerInstallation(path.resolve("src")),
				producerDigests: compilerProducerDigestsForRoot(
					path.resolve("src"),
					maligatorCacheDirectory(),
				),
				invalidatedPaths: [],
				invalidateAll: false,
				dependencyWorker: {
					tool: process.execPath,
					args: [path.resolve("src/index.ts")],
				},
			},
		);
		expect(prepared.phases.workerMs).toBeGreaterThan(0);
		expect(prepared.artifactMisses).toBeGreaterThanOrEqual(2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);
