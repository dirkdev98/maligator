import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { vmSafepointRootMapsAreTrusted } from "../../src/compiler/target/runtime-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-collection-receiver.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-collection-receiver-"));

describe("exact collection receiver brands", () => {
	let compiled: string;
	let interpreted: string;
	let trustedCompiled: string;
	let trustedInterpreted: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-collection-receiver",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		const directCollectionCalls = pair.programImage.runtime.functions
			.flatMap((fn) => fn.instructions)
			.flatMap((instruction) =>
				instruction.opcode === "CALL_KNOWN"
					? [instruction.operation]
					: instruction.opcode === "CALL" && instruction.guardedBuiltinCall !== undefined
						? [instruction.guardedBuiltinCall.operation]
						: [],
			);
		expect(directCollectionCalls).toContain("Map.prototype.get");
		expect(directCollectionCalls).toContain("WeakMap.prototype.get");
		expect(directCollectionCalls).toContain("WeakSet.prototype.has");
		for (const brand of ["WeakMap", "WeakSet"])
			expect(
				pair.programImage.native.functions.some((fn) =>
					fn.instructions.some(
						(plan) => plan?.kind === "call" && plan.exactCollectionReceiver === brand,
					),
				),
			).toBe(true);
		compiled = pair.compiled;
		interpreted = pair.interpreted;

		const trusted = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-collection-receiver-trusted-interpreted",
			entryGoal: "script",
			mainFile: "runtime/test262_main.c",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked", realms: true } }),
		});
		for (const operation of ["WeakMap.prototype.get", "WeakSet.prototype.has"])
			expect(
				trusted.programImage.runtime.functions.some((fn) =>
					fn.instructions.some(
						(instruction) =>
							instruction.opcode === "CALL" &&
							instruction.guardedBuiltinCall?.operation === operation,
					),
				),
			).toBe(true);
		// Frontend cache decoding intentionally discards VM root-map trust.
		const fresh = compileEntrypoint(path.resolve(fixture), {
			buildConfig: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		const trustedCollectionSites = [
			...fresh.runtime.functions,
			...trusted.programImage.runtime.functions,
		].flatMap((fn) =>
			vmSafepointRootMapsAreTrusted(fn)
				? fn.instructions.flatMap((instruction, instructionIp) =>
						(instruction.opcode === "CALL_KNOWN" &&
							[
								"Map.prototype.set",
								"Set.prototype.add",
								"WeakMap.prototype.set",
								"WeakSet.prototype.add",
							].includes(instruction.operation)) ||
						(instruction.opcode === "CALL" &&
							instruction.guardedBuiltinCall !== undefined)
							? [
									{
										instruction,
										safepoint: fn.gcSafepoints?.find(
											({ instructionIp: candidate }) => candidate === instructionIp,
										),
									},
								]
							: [],
					)
				: [],
		);
		for (const opcode of ["CALL_KNOWN", "CALL"] as const) {
			expect(
				trustedCollectionSites.some(({ instruction }) => instruction.opcode === opcode),
			).toBe(true);
		}
		for (const { instruction, safepoint } of trustedCollectionSites) {
			expect(safepoint).toBeDefined();
			const inputs = [instruction.thisValue, ...instruction.arguments];
			if (instruction.opcode === "CALL") inputs.push(instruction.callee);
			if (inputs.includes(instruction.dst)) {
				expect(safepoint?.clearRegisters?.includes(instruction.dst) ?? false).toBe(false);
			} else if (safepoint?.rootRegisters.includes(instruction.dst)) {
				expect(safepoint.clearRegisters?.includes(instruction.dst)).toBe(true);
			}
		}
		trustedCompiled = trusted.compiled;
		trustedInterpreted = trusted.interpreted;
	}, 600_000);

	it("preserves private, global, shadowed, and cross-brand behavior", () => {
		for (const [binary, realmApi] of [
			[compiled, false],
			[interpreted, false],
			[trustedCompiled, true],
			[trustedInterpreted, true],
		] as const) {
			assertExactLines(
				runToStdout(binary, { env: realmApi ? { MAL_TEST262: "1" } : {} }),
				["exact-collection-receiver PASS"],
			);
		}
	});

	it("keeps collection contents alive under GC stress", () => {
		for (const [binary, realmApi] of [
			[compiled, false],
			[interpreted, false],
			[trustedCompiled, true],
			[trustedInterpreted, true],
		] as const) {
			assertExactLines(
				runToStdout(binary, {
					env: { ...STRESS_ENV, ...(realmApi ? { MAL_TEST262: "1" } : {}) },
				}),
				["exact-collection-receiver PASS"],
			);
		}
	});
});
