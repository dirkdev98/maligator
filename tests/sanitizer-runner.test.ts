import { describe, expect, it } from "vitest";
import { sanitizerEnvironment } from "../scripts/test-sanitize.ts";

describe("sanitizer runner", () => {
	it("uses UBSan on Darwin where ASan deadlocks during loader initialization", () => {
		expect(sanitizerEnvironment("darwin")).toEqual({ MAL_UBSAN: "1" });
	});

	it("uses the combined ASan and UBSan compiler mode elsewhere", () => {
		expect(sanitizerEnvironment("linux")).toEqual({ MAL_ASAN: "1" });
	});
});
