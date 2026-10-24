import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { nativeInstructionEffects } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each(
	[false, true].flatMap((profile) =>
		[false, true].map((locked) => [profile, locked] as const),
	),
)(
	"preserves operator completion and coercion order under GC with profiling=%s and locked primordials=%s",
	(profile, locked) => {
		const fixture = locked
			? "tests/local/operator-completion-effects.mjs"
			: "tests/local/mutable-comparison-effects.mjs";
		const directory = mkdtempSync(join(tmpdir(), "mal-operator-completion-"));
		try {
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
			});
			const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage(
				{
					fixture,
					name: `operator-completion-${profile}-${locked}`,
					outDir: directory,
					mainFile: HOST_MAIN,
					nativeStackRoots: "precise",
					profileEnabled: profile,
					config: resolveBuildConfig({
						engine: { primordials: locked ? "locked" : "mutable" },
					}),
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
			for (const [name, count, throwing, collection, reentry] of [
				["primitiveRelation", 8, false, false, false],
				["mixedRelation", 8, false, false, false],
				["nullableObjectEqual", 1, false, false, false],
				["bigintStringEqual", 1, false, true, false],
				["symbolLess", 1, true, true, false],
				["coerciveEqual", 1, true, true, true],
				["fusedRelation", 1, false, false, false],
			] as const) {
				const fn = programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				const comparisons = fn.body.instructions.flatMap((op, ip) =>
					op.opcode === "BINARY" && op.operator !== "+" ? [{ op, ip }] : [],
				);
				expect(comparisons.length).toBeGreaterThanOrEqual(count);
				const mutableResult =
					!locked && ["mixedRelation", "bigintStringEqual", "symbolLess"].includes(name);
				for (const { op, ip } of comparisons) {
					const expectedEffects =
						op.operator === "===" || op.operator === "!=="
							? { throwing: false, collection: false, reentry: false }
							: mutableResult
								? { throwing: true, collection: true, reentry: true }
								: { throwing, collection, reentry };
					expect(
						nativeInstructionEffects(op, fn.facts?.[ip]),
						`${name} comparison ${ip}`,
					).toMatchObject(expectedEffects);
				}
				if (name === "primitiveRelation") expect(fn.storage!.rootRegisters).toEqual([]);
				if (
					name === "mixedRelation" ||
					name === "bigintStringEqual" ||
					name === "nullableObjectEqual"
				) {
					const c = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
					expect(c.includes("mal_vm_binary_op(")).toBe(mutableResult);
				}
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
