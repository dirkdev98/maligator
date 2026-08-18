import { describe, expect, it } from "vitest";
import {
	cleanTestEnvironment,
	isCanonicalTestEnvironmentChild,
} from "../scripts/test-environment.ts";
import { sanitizerEnvironment } from "../scripts/test-sanitize.ts";
import { scaledNativeRunTimeoutMs } from "../src/test-harness.ts";

describe("sanitizer runner", () => {
	it("scales native child deadlines only for instrumented builds", () => {
		expect(scaledNativeRunTimeoutMs(20000, {})).toBe(20000);
		expect(scaledNativeRunTimeoutMs(20000, { MAL_UBSAN: "1" })).toBe(60000);
		expect(scaledNativeRunTimeoutMs(20000, { MAL_ASAN: "1" })).toBe(60000);
	});

	it("uses UBSan on Darwin where ASan deadlocks during loader initialization", () => {
		expect(sanitizerEnvironment("darwin")).toEqual({
			MAL_UBSAN: "1",
			UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
		});
	});

	it("uses the combined ASan and UBSan compiler mode elsewhere", () => {
		expect(sanitizerEnvironment("linux")).toEqual({
			MAL_ASAN: "1",
			ASAN_OPTIONS: "abort_on_error=1:detect_leaks=1:halt_on_error=1",
			UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
		});
	});

	it("scrubs ambient runtime dimensions but preserves explicit throughput controls", () => {
		expect(
			cleanTestEnvironment(
				{ MAL_GC_VERIFY: "1" },
				{
					ASAN_OPTIONS: "ambient",
					DYLD_LIBRARY_PATH: "/ambient",
					LD_AUDIT: "ambient.so",
					MALLOC_PERTURB_: "1",
					MallocCheckHeapStart: "1",
					MAL_GC_STRESS: "1",
					NODE_OPTIONS: "--inspect",
					PATH: "/bin",
					T262_COMPILE_WORKERS: "4",
					T262_OBJCACHE: "1",
					T262_VARIANT: "strict",
					WPT_ROOT: "/ambient/wpt",
				},
			),
		).toEqual({
			MAL_GC_VERIFY: "1",
			PATH: "/bin",
			T262_COMPILE_WORKERS: "4",
			T262_OBJCACHE: "1",
		});
	});

	it("does not trust a spoofed canonical-child marker with ambient dimensions", () => {
		const marker = "TEST_CANONICAL_CHILD";
		expect(
			isCanonicalTestEnvironmentChild(
				marker,
				{ MAL_INTERP: "1" },
				{
					[marker]: "1",
					MAL_INTERP: "1",
					PATH: "/bin",
				},
			),
		).toBe(true);
		expect(
			isCanonicalTestEnvironmentChild(
				marker,
				{},
				{
					[marker]: "1",
					MAL_INTERP: "1",
					PATH: "/bin",
				},
			),
		).toBe(false);
	});
});
