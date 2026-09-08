import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { vmSafepointRootMapsAreTrusted } from "../../src/compiler/target/runtime-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-collection-receiver.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-collection-receiver-"));

describe("exact collection receiver brands", () => {
	let compiled: string;
	let interpreted: string;
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
			.filter((instruction) => instruction.opcode === "CALL_KNOWN")
			.map((instruction) => instruction.operation);
		expect(directCollectionCalls).toContain("Map.prototype.get");
		compiled = pair.compiled;
		interpreted = pair.interpreted;

		const trusted = buildNativeBinaryResult({
			fixture,
			name: "exact-collection-receiver-trusted-interpreted",
			compiled: false,
			entryGoal: "script",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		const trustedCollectionSites = trusted.programImage.runtime.functions.flatMap((fn) =>
			vmSafepointRootMapsAreTrusted(fn)
				? fn.instructions.flatMap((instruction, instructionIp) =>
						instruction.opcode === "CALL_KNOWN" ||
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
				trustedCollectionSites.some(
					({ instruction, safepoint }) =>
						instruction.opcode === opcode &&
						safepoint?.clearRegisters?.includes(instruction.dst) === true,
				),
			).toBe(true);
		}
		trustedInterpreted = trusted.binaryPath;
	}, 600_000);

	it("preserves private, global, shadowed, and cross-brand behavior", () => {
		for (const binary of [compiled, interpreted, trustedInterpreted]) {
			assertExactLines(runToStdout(binary), ["exact-collection-receiver PASS"]);
		}
	});

	it("keeps collection contents alive under GC stress", () => {
		for (const binary of [compiled, interpreted, trustedInterpreted]) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"exact-collection-receiver PASS",
			]);
		}
	});
});
