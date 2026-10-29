import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves private accessor fallbacks and boxed predicate callbacks under collection", () => {
	const fixture = "tests/local/compiler-entry-chains.js";
	const output = mkdtempSync(path.join(os.tmpdir(), "mal-entry-chains-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "compiler-entry-chains",
			outDir: output,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: {
					eval: false,
					realms: false,
					intl: { enabled: false },
					primordials: "mutable",
				},
				surface: { node: false, webPlatform: false },
			}),
		});
		expect(
			pair.programImage.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
		).toContainEqual(
			expect.objectContaining({
				parameters: ["boxed", "number"],
				resultRepresentation: "boolean",
			}),
		);
		const helper = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "#require",
		)!;
		expect(helper).toBeDefined();
		expect(
			emitCompiledFunction(helper, helper.functionIndex, "", false)?.trySymbol,
		).toBeDefined();
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(
				runToStdout(binary, {
					env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
					timeoutMs: 30_000,
				}),
			).toBe(expected);
		}
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}, 120_000);
