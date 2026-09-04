import { describe, expect, it } from "vitest";
import { sampledCompilerAllocationSummary } from "../scripts/compiler-profile-summary.ts";
import type { CompilerAllocationProfileNode } from "../scripts/compiler-profile-summary.ts";

const frame = (functionName: string, url = "", lineNumber = 0) => ({
	functionName,
	url,
	lineNumber,
});

describe("compiler profile summary", () => {
	it("attributes built-in allocation samples to their closest repository owner", () => {
		const profile: CompilerAllocationProfileNode = {
			callFrame: frame("(root)"),
			selfSize: 0,
			children: [
				{
					callFrame: frame("outside"),
					selfSize: 40,
					children: [],
				},
				{
					callFrame: frame(
						"optimizeCore",
						"file:///repo/src/compiler/core/optimize.ts",
						9,
					),
					selfSize: 0,
					children: [
						{
							callFrame: frame(
								"memoryVersions",
								"file:///repo/src/compiler/core/core-ir-memory.ts",
								19,
							),
							selfSize: 0,
							children: [
								{
									callFrame: frame("Map"),
									selfSize: 100,
									children: [
										{
											callFrame: frame("set"),
											selfSize: 50,
											children: [],
										},
									],
								},
							],
						},
						{
							callFrame: frame("push"),
							selfSize: 30,
							children: [],
						},
					],
				},
			],
		};

		expect(sampledCompilerAllocationSummary(profile, "file:///repo/")).toEqual({
			sampledBytes: 220,
			sampledOptimizeCoreBytes: 180,
			sampledOptimizeCoreAttributedBytes: 180,
			allocationHotspots: [
				{ function: "Map", source: "", line: 1, weight: 100 },
				{ function: "set", source: "", line: 1, weight: 50 },
				{ function: "push", source: "", line: 1, weight: 30 },
			],
			allocationOwnerHotspots: [
				{
					function: "memoryVersions",
					source: "file:///repo/src/compiler/core/core-ir-memory.ts",
					line: 20,
					weight: 150,
				},
				{
					function: "optimizeCore",
					source: "file:///repo/src/compiler/core/optimize.ts",
					line: 10,
					weight: 30,
				},
			],
		});
	});

	it("reports optimizeCore allocation that has no repository owner as unattributed", () => {
		const profile: CompilerAllocationProfileNode = {
			callFrame: frame("optimizeCore"),
			selfSize: 64,
			children: [],
		};

		const summary = sampledCompilerAllocationSummary(profile, "file:///repo/");
		expect(summary.sampledOptimizeCoreBytes).toBe(64);
		expect(summary.sampledOptimizeCoreAttributedBytes).toBe(0);
		expect(summary.allocationOwnerHotspots).toEqual([]);
	});
});
