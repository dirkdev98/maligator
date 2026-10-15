import { describe, expect, it } from "vitest";
import {
	EFFECT_DOMAINS,
	EVERY_EFFECT_SUMMARY,
	NO_EFFECT_SUMMARY,
	effectSummariesEqual,
	effectSummaryCovers,
	joinEffectSummaries,
	normalizeEffectDomains,
} from "../src/compiler/shared/effect-summary.ts";
import type { EffectSummary } from "../src/compiler/shared/effect-summary.ts";

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

	it("retains a covering summary until an independent flag or domain grows", () => {
		const covering: EffectSummary = {
			...NO_EFFECT_SUMMARY,
			reads: ["captured-slot", "io"],
			writes: ["object-property"],
			mayThrow: true,
		};
		const covered: EffectSummary = {
			...NO_EFFECT_SUMMARY,
			reads: ["io"],
			mayThrow: true,
		};
		expect(joinEffectSummaries(covering, covered)).toBe(covering);
		expect(joinEffectSummaries(covered, covering)).toBe(covering);
		const suspended = joinEffectSummaries(covering, {
			...covered,
			maySuspend: true,
		});
		expect(suspended).toEqual({ ...covering, maySuspend: true });
		expect(effectSummaryCovers(covering, suspended)).toBe(false);
		expect(
			joinEffectSummaries(suspended, {
				...covered,
				writes: ["array-element"],
			}),
		).toEqual({
			...suspended,
			writes: ["object-property", "array-element"],
		});
	});

	it("normalizes bottom joins and saturates only after every dimension reaches top", () => {
		const unnormalized: EffectSummary = {
			...NO_EFFECT_SUMMARY,
			reads: ["io", "captured-slot", "io"],
		};
		for (const [left, right] of [
			[NO_EFFECT_SUMMARY, unnormalized],
			[unnormalized, NO_EFFECT_SUMMARY],
		]) {
			expect(joinEffectSummaries(left!, right!)).toEqual({
				...NO_EFFECT_SUMMARY,
				reads: ["captured-slot", "io"],
			});
		}
		const nonsuspending: EffectSummary = {
			...EVERY_EFFECT_SUMMARY,
			maySuspend: false,
		};
		expect(joinEffectSummaries(nonsuspending, { ...NO_EFFECT_SUMMARY })).toBe(
			nonsuspending,
		);
		const top = joinEffectSummaries(nonsuspending, {
			...NO_EFFECT_SUMMARY,
			maySuspend: true,
		});
		expect(top).toBe(EVERY_EFFECT_SUMMARY);
		expect(joinEffectSummaries(top, unnormalized)).toBe(top);
		expect(joinEffectSummaries(unnormalized, top)).toBe(top);
	});

	it("unions every pair of memory domains independently of input order", () => {
		for (const leftDomain of EFFECT_DOMAINS) {
			for (const rightDomain of EFFECT_DOMAINS) {
				const left: EffectSummary = {
					...NO_EFFECT_SUMMARY,
					reads: [leftDomain, leftDomain],
					writes: [rightDomain],
					mayGc: true,
				};
				const right: EffectSummary = {
					...NO_EFFECT_SUMMARY,
					reads: [rightDomain],
					writes: [leftDomain, leftDomain],
					callsUserCode: true,
				};
				const expectedDomains = EFFECT_DOMAINS.filter(
					(domain) => domain === leftDomain || domain === rightDomain,
				);
				const union = joinEffectSummaries(left, right);
				expect(union).toEqual({
					...NO_EFFECT_SUMMARY,
					reads: expectedDomains,
					writes: expectedDomains,
					mayGc: true,
					callsUserCode: true,
				});
				expect(effectSummariesEqual(union, joinEffectSummaries(right, left))).toBe(true);
			}
		}
	});
});
