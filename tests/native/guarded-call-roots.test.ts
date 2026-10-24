import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([false, true])(
	"retains detached private values across guarded hits, collecting misses and throws with profiling=%s",
	(profile) => {
		const fixture = "tests/local/guarded-call-roots.mjs";
		const directory = mkdtempSync(join(tmpdir(), "mal-guarded-call-roots-"));
		try {
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage(
				{
					fixture,
					name: `guarded-call-roots-${profile}`,
					outDir: directory,
					mainFile: HOST_MAIN,
					nativeStackRoots: "precise",
					profileEnabled: profile,
					config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
				},
			);
			let kernels = 0;
			for (const fn of programImage.native.functions) {
				const name = String.fromCharCode(
					...(programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				);
				if (!name.startsWith("retain") && !name.startsWith("consume")) continue;
				kernels++;
				const held = fn.body.instructions.find(
					(op) =>
						op.opcode === "LOAD_PROPERTY_STATIC" &&
						String.fromCharCode(
							...programImage.runtime.stringConstants[op.stringIndex]!,
						) === "value",
				);
				expect(held?.opcode).toBe("LOAD_PROPERTY_STATIC");
				if (held?.opcode !== "LOAD_PROPERTY_STATIC")
					throw new Error("Missing held value");
				expect(fn.storage!.privateRegisters).toContain(held.dst);
				const source = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
				expect(source).toContain("mal_vm_call_cached");
				expect(source).toMatch(
					/mal_(?:builtin_(?:boolean|number_predicate|math_[a-z]+)_callee_matches|data_view_accessor_is|builtin_string_char_code_at_(?:try|direct))/,
				);
			}
			expect(kernels).toBe(16);
			for (const binary of [compiled, interpreted]) {
				for (const stress of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...stress } })).toBe(
						expected,
					);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300_000,
);
