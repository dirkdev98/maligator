import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { COMPILER_VALUE_KIND_BOOLEAN } from "../../src/compiler/shared/compiler-value-kinds.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixtures = [
	{
		name: "object predicate results",
		fixture: "tests/local/object-predicate-results.mjs",
		optimized: [],
		scalarResults: [
			["objectFrozen", "Object.isFrozen"],
			["reflectDefine", "Reflect.defineProperty"],
			["reflectSet", "Reflect.set"],
			["reflectList", "Reflect.has"],
			["reflectSpread", "Reflect.has"],
		] as const,
	},
	{
		name: "membership",
		fixture: "tests/local/static-property-membership.mjs",
		optimized: [
			"symbolRead",
			"cellSymbolRead",
			"registryCellRead",
			"capturedCellRead",
		].map((functionName) => ({ functionName, forbidden: ["LOAD_PROPERTY"] })),
	},
	{
		name: "enumerability",
		fixture: "tests/local/own-enumerability.mjs",
		optimized: [
			{
				functionName: "enumerableData",
				forbidden: ["CALL", "CALL_KNOWN", "CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			},
			{ functionName: "joinedEnumerable", forbidden: ["CALL", "CALL_KNOWN"] },
		],
	},
	{
		name: "joined key bounds",
		fixture: "tests/local/joined-object-key-bounds.mjs",
		optimized: [
			...["joinedMissing", "joinedDescriptor"].map((functionName) => ({
				functionName,
				forbidden: ["CALL", "CALL_KNOWN", "CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			})),
			{
				functionName: "joinedEffects",
				forbidden: ["CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			},
			{
				functionName: "joinedPrimitiveEffects",
				forbidden: ["CREATE_OBJECT", "CREATE_OBJECT_SHAPED"],
			},
		],
	},
];
it.each(
	fixtures.flatMap((fixture) =>
		(["mutable", "locked"] as const).map((primordials) => ({ ...fixture, primordials })),
	),
)(
	"preserves $name with $primordials primordials",
	(testCase) => {
		const { fixture, name, optimized, primordials } = testCase;
		const environment = { MAL_PRIMORDIALS: primordials };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...environment },
		});
		const directory = mkdtempSync(join(tmpdir(), "mal-static-membership-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name,
				mainFile: HOST_MAIN,
				outDir: directory,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				nativeStackRoots: "precise",
			});
			if (primordials === "locked") {
				if ("scalarResults" in testCase && testCase.scalarResults !== undefined) {
					for (const [functionName, operation] of testCase.scalarResults) {
						const index = pair.programImage.runtime.functions.findIndex(
							(fn) =>
								String.fromCharCode(
									...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ??
										[]),
								) === functionName,
						);
						expect(index).toBeGreaterThanOrEqual(0);
						const fn = pair.programImage.native.functions[index]!;
						const ip = fn.body.instructions.findIndex(
							(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
						);
						expect(ip, functionName).toBeGreaterThanOrEqual(0);
						const call = fn.body.instructions[ip]!;
						if (call.opcode !== "CALL_KNOWN")
							throw new Error("Expected exact builtin invocation");
						expect(fn.facts?.[ip]?.resultKindMasks).toEqual([
							COMPILER_VALUE_KIND_BOOLEAN,
						]);
						expect(fn.storage!.rootRegisters).not.toContain(call.dst);
					}
				}
				for (const { functionName, forbidden } of optimized) {
					const index = pair.programImage.runtime.functions.findIndex(
						(fn) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
							) === functionName,
					);
					expect(index).toBeGreaterThanOrEqual(0);
					expect(
						pair.programImage.runtime.functions[index]!.instructions.some((instruction) =>
							forbidden.includes(instruction.opcode),
						),
					).toBe(false);
				}
			}
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env: environment })).toBe(expected);
				expect(runToStdout(binary, { env: { ...environment, ...STRESS_ENV } })).toBe(
					expected,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	600000,
);
