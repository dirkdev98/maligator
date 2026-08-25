import { describe, expect, it } from "vitest";
import {
	parseMacPowerActivity,
	shouldDeferHeavyCommand,
} from "../scripts/agent-environment.ts";
import {
	commandEnvironmentPlan,
	mergeCommandRequirements,
	requirementsForCommand,
} from "../scripts/command-requirements.ts";

describe("machine-readable command requirements", () => {
	it("merges sandbox capabilities without inventing an execution lock", () => {
		const requirements = mergeCommandRequirements([
			requirementsForCommand("quality"),
			requirementsForCommand("native"),
		]);
		const plan = commandEnvironmentPlan(requirements, { workspace: "/workspace" });

		expect(plan.requirements.cpu).toBe("heavy");
		expect(plan.requirements.capabilities.loopbackListen).toBe(true);
		expect(plan.requirements.capabilities.cargoCacheWrite).toBe(true);
		expect(plan.coordination).toEqual({
			inspectCpuBeforeHeavyWork: true,
			deferWhenBusy: true,
			performanceLock: false,
		});
	});

	it("recommends voluntary deferral from activity, never a lock", () => {
		const quiet = {
			logicalCpus: 8,
			loadAverage1m: 1,
			loadPerCpu: 0.125,
			topProcesses: [],
			processInspectionAvailable: true,
		};
		expect(shouldDeferHeavyCommand(quiet, 0)).toBe(false);
		expect(shouldDeferHeavyCommand(quiet, 1)).toBe(true);
		expect(
			shouldDeferHeavyCommand(
				{ ...quiet, topProcesses: [{ pid: 2, cpuPercent: 90, command: "cc" }] },
				0,
			),
		).toBe(true);
	});

	it("reports nominal AC separately from a discharging battery", () => {
		expect(
			parseMacPowerActivity(
				"Now drawing from 'AC Power'\n -InternalBattery-0\t100%; discharging; 7:09 remaining present: true\n",
			),
		).toEqual({
			inspectionAvailable: true,
			source: "ac",
			battery: {
				percentage: 100,
				state: "discharging",
				estimatedRemaining: "7:09 remaining",
			},
			performanceContext: "battery",
		});
		expect(
			parseMacPowerActivity(
				"Now drawing from 'Battery Power'\n -InternalBattery-0\t61%; discharging; 2:10 remaining present: true\n",
			).source,
		).toBe("battery");
		expect(
			parseMacPowerActivity(
				"Now drawing from 'AC Power'\n -InternalBattery-0\t91%; charging; 0:31 remaining present: true\n",
			).performanceContext,
		).toBe("ac");
	});
});
