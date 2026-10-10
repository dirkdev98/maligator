import { describe, expect, it } from "vitest";
import { lowerNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function sparseWindows(pureSteps: number) {
	const prefix = Array.from(
		{ length: pureSteps },
		(_, index) => `delta = (delta ^ ${index}) >>> 0;`,
	).join("\n");
	return inspectStaticValueFunction(
		`function compute(value,gate,delta) {
			${prefix}
			const first = value.count++;
			gate();
			const sum = value.left - value.right;
			gate();
			const second = value.count += delta;
			return [first,sum,second,value.label];
		} globalThis.compute = compute;`,
		"compute",
	);
}

describe("shared native property candidate indexing", () => {
	it.each([0, 64, 512])(
		"retains disjoint windows and effect barriers after %s pure steps",
		(pureSteps) => {
			const { native } = sparseWindows(pureSteps);
			const body = analyzeNativeBodyFacts(native.body);
			const args = [
				native.body,
				native.registerRepresentations,
				body.jumpTargets,
				() => false,
				{ kind: "select" },
			] as const;
			const standalone = lowerNativeFastPaths(...args);
			const shared = lowerNativeFastPaths(
				...args,
				[],
				() => undefined,
				new Set(),
				true,
				body,
			);
			expect(shared).toEqual(standalone);
			expect(shared.propertyNumericUpdates).toHaveLength(2);
			expect(shared.propertyProjections).toHaveLength(1);
			expect(native.body.instructions.length).toBeGreaterThan(pureSteps);
			const windows = [...shared.propertyNumericUpdates, ...shared.propertyProjections];
			for (const plan of windows)
				expect(
					plan.claimedIps.some((ip) => native.body.instructions[ip]!.opcode === "CALL"),
				).toBe(false);
		},
	);

	it("replays persisted windows without requesting a candidate index", () => {
		const { native } = sparseWindows(0);
		const body = analyzeNativeBodyFacts(native.body);
		const plans = lowerNativeFastPaths(
			native.body,
			native.registerRepresentations,
			body.jumpTargets,
			() => false,
			{ kind: "select" },
		);
		const replay = () =>
			lowerNativeFastPaths(
				native.body,
				native.registerRepresentations,
				body.jumpTargets,
				() => false,
				{ kind: "render", plans },
				[],
				() => undefined,
				new Set(),
				true,
				{
					...body,
					get staticPropertyLoadIps(): ReadonlyArray<number> {
						throw new Error("Rendering must consume the persisted selection");
					},
				},
			);
		expect(replay().propertyNumericUpdates).toEqual(plans.propertyNumericUpdates);
		expect(replay().propertyProjections).toEqual(plans.propertyProjections);
	});
});
