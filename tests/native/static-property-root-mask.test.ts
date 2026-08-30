import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/static-property-root-mask.js";

describe("native static-property root-mask publication", () => {
	let binary: string;
	let genericStaticSafepointLoadCount = 0;

	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture,
			name: "static-property-root-mask",
			compiled: true,
		});
		binary = result.binaryPath;
		genericStaticSafepointLoadCount = result.programImage.runtime.functions.reduce(
			(count, fn, functionIndex) => {
				const native = result.programImage.native.functions[functionIndex]!;
				const operationSafepoints = new Set(
					native.gc.safepoints
						.filter((safepoint) => safepoint.kind === "operation")
						.map((safepoint) => safepoint.instructionIp),
				);
				return (
					count +
					fn.instructions.filter(
						(instruction, ip) =>
							instruction.opcode === "LOAD_PROPERTY_STATIC" &&
							native.instructions[ip] === undefined &&
							operationSafepoints.has(ip),
					).length
				);
			},
			0,
		);
	}, 600_000);

	it("preserves own, inherited, watched, Proxy, and getter load paths", () => {
		expect(genericStaticSafepointLoadCount).toBeGreaterThanOrEqual(2);
		assertExactLines(runToStdout(binary), ["static-property-root-mask PASS"]);
	});

	it("republishes live roots at the real safepoint after a cache hit", () => {
		assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
			"static-property-root-mask PASS",
		]);
	});
});
