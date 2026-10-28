import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../../src/compiler/shared/compiler-value-kinds.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../../src/compiler/shared/integer-range.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("fresh record field kind observations", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves coercion, mutation, prototypes and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-record-field-kinds-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/record-field-kinds.mjs",
					name: `record-field-kinds-${primordials}`,
					mainFile: HOST_MAIN,
					outDir,
					nativeStackRoots: "precise",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: true },
					}),
				});
				const named = (name: string) =>
					pair.programImage.native.functions.find(
						(candidate) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[
									candidate.body.nameStringIndex
								] ?? []),
							) === name,
					)!;
				for (const name of [
					"writeOwnRecord",
					"writeOwnSuspended",
					"writeOwnAwaited",
					"writeOwnAsyncSuspended",
				]) {
					const fn = named(name);
					expect(fn, name).toBeDefined();
					expect(
						fn.body.instructions.some(
							(op, ip) =>
								(op.opcode === "STORE_PROPERTY_STATIC" ||
									op.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
								fn.instructions[ip]?.kind === "known-own-data",
						),
						name,
					).toBe(true);
				}
				for (const name of [
					"readStable",
					"readUnion",
					"readMergedNumber",
					"readMergedRecursive",
				]) {
					expect(named(name)).toBeDefined();
					expect(
						named(name).body.instructions.some(
							({ opcode }) => opcode === "TYPEOF_COMPARE",
						),
					).toBe(false);
				}
				const unknown = named("readUnknownRecord");
				expect(unknown).toBeDefined();
				expect(unknown.instructions.some((plan) => plan?.kind === "known-own-data")).toBe(
					true,
				);
				expect(
					named("readMergedHeap").instructions.some(
						(plan) => plan?.kind === "known-own-data",
					),
				).toBe(true);
				for (const name of [
					"readEscaped",
					"readGetterMutated",
					"readPublic",
					"readAfterInheritedWrite",
					"readProducerMissing",
					"readMergedInherited",
				]) {
					expect(named(name)).toBeDefined();
					expect(
						named(name).body.instructions.some(
							(op) => op.opcode === "UNARY" && op.operator === "typeof",
						),
					).toBe(true);
					expect(
						named("readForwardedMixed").facts?.some((fact) =>
							fact?.resultKindMasks?.includes(
								COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
							),
						),
					).toBe(true);
				}
				for (const [name, range] of [
					[
						"readForwardedWritten",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 1023 },
					],
					["readDefiniteRecord", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					[
						"readProducerOverwrite",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					[
						"readProducerForwardOverwrite",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["readBounded", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					[
						"readConditionalRecord",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["readLoopRecord", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["readBeforeFieldWrite", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["readSiblingWritten", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					[
						"readCompatibleWritten",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["readWrittenLoop", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["readProducerWritten", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					[
						"readProducerConstructed",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["producerSuspended", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["producerAwaited", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					[
						"producerAsyncSuspended",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["writtenSuspended", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["writtenAwaited", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["readWidenedWritten", COMPILER_UINT32_RANGE],
					[
						"readBeforeRecordGetter",
						{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
					],
					["readFreshLoop", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["pointSuspended", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["readBoundedUnsigned", COMPILER_UINT32_RANGE],
					["boundedSuspended", COMPILER_INT32_RANGE],
					["boundedAwaited", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
					["boundedAsyncSuspended", COMPILER_UINT32_RANGE],
				] as const) {
					const fn = named(name);
					expect(
						fn.facts?.some((fact) =>
							fact?.resultIntegerRanges?.some(
								(candidate) =>
									candidate?.minimum === range.minimum &&
									candidate.maximum === range.maximum,
							),
						),
						name,
					).toBe(true);
				}
				for (const binary of [pair.compiled, pair.interpreted])
					for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
						assertExactLines(runToStdout(binary, { env }), ["record-field-kinds PASS"]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
	);
});
