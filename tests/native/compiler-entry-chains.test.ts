import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/compiler-entry-chains.js";
const output = mkdtempSync(path.join(os.tmpdir(), "mal-entry-chains-"));
let expected: string;
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;

beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	pair = buildBackendPairFromOneProgramImage({
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
});

afterAll(() => rmSync(output, { recursive: true, force: true }));

it("matches Node for compiler helper chains under collection", () => {
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
	const maybeVoid = pair.programImage.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "maybeVoid",
	)!;
	expect(
		emitCompiledFunction(maybeVoid, maybeVoid.functionIndex, "", false)?.tryAbi?.result
			.kind,
	).toBe("boxed");
	const identityOrClone = pair.programImage.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "identityOrClone",
	)!;
	expect(
		emitCompiledFunction(identityOrClone, identityOrClone.functionIndex, "", false)
			?.tryAbi?.result,
	).toEqual({ kind: "parameter", index: 0 });
	const readReady = pair.programImage.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "readReady",
	)!;
	expect(
		emitCompiledFunction(readReady, readReady.functionIndex, "", false)?.tryAbi
			?.parameters,
	).toEqual([]);
	for (const binary of [pair.compiled, pair.interpreted]) {
		expect(
			runToStdout(binary, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				timeoutMs: 30_000,
			}),
		).toBe(expected);
	}
}, 120_000);
