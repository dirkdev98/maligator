import { describe, expect, it } from "vitest";
import { normalizeRuntimeBuildArgument } from "../src/native-cache-identity.ts";

describe("native cache identity", () => {
	it("removes checkout-specific runtime paths", () => {
		const runtime = "/checkout/runtime";
		expect(normalizeRuntimeBuildArgument(runtime, `${runtime}/src/vm.c`)).toBe(
			"<runtime>/src/vm.c",
		);
		expect(
			normalizeRuntimeBuildArgument(runtime, `-ffile-prefix-map=${runtime}=<runtime>`),
		).toBe("-ffile-prefix-map=<runtime>=<runtime>");
		expect(normalizeRuntimeBuildArgument(runtime, "/toolchain/include")).toBe(
			"/toolchain/include",
		);
	});
});
