import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { vmSafepointRootMapsAreTrusted } from "../../src/compiler/target/runtime-image.ts";
import {
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-safepoint-satb-exact-roots-"));
const expected = "safepoint-satb-exact-roots PASS\n";

describe("portable exact roots at concurrent SATB frame migrations", () => {
	let binary: string;

	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture: "tests/local/safepoint-satb-exact-roots.js",
			name: "safepoint-satb-exact-roots",
			compiled: false,
			entryGoal: "script",
			mainFile: HOST_MAIN,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		binary = result.binaryPath;

		const generator = result.programImage.runtime.functions.find(
			(fn) => fn.isGenerator && fn.instructions.some(({ opcode }) => opcode === "YIELD"),
		);
		expect(generator).toBeDefined();
		expect(vmSafepointRootMapsAreTrusted(generator!)).toBe(true);
		const yieldIp = generator!.instructions.findIndex(({ opcode }) => opcode === "YIELD");
		const yieldRoots = generator!.gcSafepoints?.find(
			({ instructionIp }) => instructionIp === yieldIp,
		);
		expect(yieldRoots).toBeDefined();
		const deadObject = generator!.instructions
			.slice(0, yieldIp)
			.reverse()
			.find(
				(instruction) =>
					instruction.opcode === "CREATE_OBJECT" ||
					instruction.opcode === "CREATE_OBJECT_SHAPED",
			);
		expect(deadObject).toBeDefined();
		if (
			deadObject?.opcode !== "CREATE_OBJECT" &&
			deadObject?.opcode !== "CREATE_OBJECT_SHAPED"
		) {
			throw new Error("expected the dead object literal to remain allocated");
		}
		expect(yieldRoots!.rootRegisters).not.toContain(deadObject.dst);
		const returnIps = generator!.instructions.flatMap((instruction, instructionIp) =>
			instruction.opcode === "RETURN" ? [instructionIp] : [],
		);
		expect(returnIps.length).toBeGreaterThan(0);
		for (const instructionIp of returnIps) {
			const roots = generator!.gcSafepoints?.find(
				(safepoint) => safepoint.instructionIp === instructionIp,
			);
			expect(roots).toBeDefined();
			expect(roots!.rootRegisters).not.toContain(deadObject.dst);
		}
	}, 600_000);

	it("does not SATB-shade dead generator registers across verified GC cycles", () => {
		expect(
			runToStdout(binary, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});
});
