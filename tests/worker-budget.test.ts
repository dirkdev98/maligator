import { describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";
import { nativeBuildEnvironmentFingerprint } from "../src/native-build-context.ts";
import { nativeBuildJobs } from "../src/native-command.ts";
import {
	buildWorkerCount,
	nestedTestWorkerAllocation,
	workerBudget,
	workerCount,
	workerEnvironment,
} from "../src/worker-budget.ts";

describe("worker allocation", () => {
	it("uses available CPU capacity for defaults and clamps explicit budgets", () => {
		expect(workerBudget(undefined, 1)).toBe(1);
		expect(workerBudget(undefined, 8)).toBe(4);
		expect(workerBudget("4", 2)).toBe(2);
		expect(workerBudget("1", 8)).toBe(1);
	});

	it.each(["0", "-1", "1.5", "1e2", "Infinity", "", "many"])(
		"rejects the invalid worker count %s",
		(value) => {
			expect(() => workerCount(value, "workers", 4, 8)).toThrow(/positive integer/);
		},
	);

	it("bounds native and Cargo pools by the allocation inherited by a test worker", () => {
		const environment = {
			...workerEnvironment(1),
			MAL_BUILD_JOBS: "8",
			CARGO_BUILD_JOBS: "8",
		};
		expect(nativeBuildJobs(environment)).toBe(1);
		expect(buildWorkerCount(environment, "CARGO_BUILD_JOBS", 8)).toBe(1);
	});

	it("splits build-heavy test pools without idling the worker budget", () => {
		expect(nestedTestWorkerAllocation(4, 17, true)).toEqual({
			testWorkers: 2,
			childBuildJobs: 2,
		});
		expect(nestedTestWorkerAllocation(4, 1, true)).toEqual({
			testWorkers: 1,
			childBuildJobs: 4,
		});
		expect(nestedTestWorkerAllocation(4, 17, false)).toEqual({
			testWorkers: 4,
			childBuildJobs: 1,
		});
	});

	it("preserves resource allocations when canonical runners remove runtime overrides", () => {
		expect(
			cleanTestEnvironment(
				{},
				{ ...workerEnvironment(2), MAL_INTERP: "1", MAL_GC_STRESS: "1", MAL_ASAN: "1" },
			),
		).toEqual(workerEnvironment(2));
	});

	it("keeps worker allocation out of native artifact identity", () => {
		expect(nativeBuildEnvironmentFingerprint(workerEnvironment(1))).toBe(
			nativeBuildEnvironmentFingerprint(workerEnvironment(4)),
		);
	});
});
