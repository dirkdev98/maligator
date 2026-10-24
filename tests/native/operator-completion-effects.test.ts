import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([false, true])(
	"preserves operator completion and coercion order under GC with profiling=%s",
	(profile) => {
		const fixture = "tests/local/operator-completion-effects.mjs";
		const directory = mkdtempSync(join(tmpdir(), "mal-operator-completion-"));
		try {
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage(
				{
					fixture,
					name: `operator-completion-${profile}`,
					outDir: directory,
					mainFile: HOST_MAIN,
					nativeStackRoots: "precise",
					profileEnabled: profile,
				},
			);
			for (const name of ["negate", "complement"]) {
				const native = programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				expect(
					emitCompiledFunction(native, native.functionIndex, "", false)!.source,
				).toMatch(/mal_vm_unary_op_fast\([^;]+;\n\s*if \(MAL_THREW\(\)\)/);
			}
			for (const binary of [compiled, interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...stress } })).toBe(
						expected,
					);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
