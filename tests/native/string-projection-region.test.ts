import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-projection-region.js";
const expected =
	"RESULT PASS 245,9,102,1010466,-12.5,16,Infinity,1,3,0,2,2,1,9,2,711,9,17,2,23 2 1";

describe("projected String producer-consumer regions", () => {
	it.each([true, false])(
		"preserves fallbacks and callback exceptions (compiled=%s)",
		(compiled) => {
			const { binaryPath, programImage } = buildNativeBinaryResult({
				fixture,
				name: `string-projection-region-${compiled ? "compiled" : "interpreted"}`,
				compiled,
			});
			if (compiled) {
				const functionIndex = programImage.runtime.functions.findIndex(
					(fn) =>
						String.fromCharCode(
							...(programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
						) === "cursorRevalidates",
				);
				expect(functionIndex).toBeGreaterThanOrEqual(0);
				expect(
					programImage.native.functions[functionIndex]?.specializations,
				).toContainEqual(
					expect.objectContaining({
						kind: "string-split-cursor",
						trimIdentity: "runtime-guarded",
					}),
				);
			}
			expect(runToStdout(binaryPath)).toContain(expected);
		},
	);

	it("keeps projected substrings rooted under verified GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "string-projection-region-stress",
			compiled: true,
		});
		expect(runToStdout(binary, { env: STRESS_ENV })).toContain(expected);
	});
});
