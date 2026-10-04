import { describe, expect, it } from "vitest";
import {
	joinEffectSummaries,
	normalizeEffectDomains,
} from "../src/compiler/shared/effect-summary.ts";

describe("effect summary normalization", () => {
	it("deduplicates ordered and unordered domain lists in declaration order", () => {
		expect(normalizeEffectDomains(["local-slot", "local-slot", "io"])).toEqual([
			"local-slot",
			"io",
		]);
		expect(
			normalizeEffectDomains(["io", "object-property", "captured-slot", "io"]),
		).toEqual(["captured-slot", "object-property", "io"]);
	});

	it("joins domain and flag dimensions independently without changing either input", () => {
		const left = Object.freeze({
			reads: Object.freeze(["io", "local-slot"] as const),
			writes: Object.freeze(["object-property"] as const),
			mayThrow: false,
			maySuspend: true,
			mayGc: false,
			callsUserCode: false,
		});
		const right = Object.freeze({
			reads: Object.freeze(["local-slot", "captured-slot"] as const),
			writes: Object.freeze(["array-element", "object-property"] as const),
			mayThrow: true,
			maySuspend: false,
			mayGc: true,
			callsUserCode: false,
		});
		const expected = {
			reads: ["captured-slot", "local-slot", "io"],
			writes: ["object-property", "array-element"],
			mayThrow: true,
			maySuspend: true,
			mayGc: true,
			callsUserCode: false,
		};
		expect(joinEffectSummaries(left, right)).toEqual(expected);
		expect(joinEffectSummaries(right, left)).toEqual(expected);
	});
});
