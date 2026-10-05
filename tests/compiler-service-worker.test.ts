import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { developmentCompilerInstallation } from "../src/cli-commands.ts";
import { parseCliArgs } from "../src/cli.ts";
import { compilerProducerDigestsForRoot } from "../src/compiler-cache-identity.ts";
import { prepare } from "../src/compiler-service-worker.ts";

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
