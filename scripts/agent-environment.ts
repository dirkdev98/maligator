import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectMaligatorCache } from "../src/cache-management.ts";
import { normalAgentEnvironmentPlan } from "./command-requirements.ts";
import { assertLoopbackAvailable } from "./test-environment.ts";

interface CpuActivity {
	logicalCpus: number;
	loadAverage1m: number;
	loadPerCpu: number;
	topProcesses: Array<{ pid: number; cpuPercent: number; command: string }>;
	processInspectionAvailable: boolean;
}

export interface PowerActivity {
	inspectionAvailable: boolean;
	source: "ac" | "battery" | "unknown";
	battery?: {
		percentage?: number;
		state: "charging" | "discharging" | "charged" | "unknown";
		estimatedRemaining?: string;
	};
	/** Power provenance for interpreting performance-sensitive measurements. */
	performanceContext: "ac" | "battery" | "unknown";
}

export function parseMacPowerActivity(output: string): PowerActivity {
	const sourceLabel = /Now drawing from '([^']+)'/i.exec(output)?.[1];
	const source =
		sourceLabel === undefined
			? "unknown"
			: /battery/i.test(sourceLabel)
				? "battery"
				: /ac power/i.test(sourceLabel)
					? "ac"
					: "unknown";
	const percentageText = /\b(\d{1,3})%/.exec(output)?.[1];
	const percentage = percentageText === undefined ? undefined : Number(percentageText);
	const state: NonNullable<PowerActivity["battery"]>["state"] = /\bdischarging\b/i.test(
		output,
	)
		? "discharging"
		: /\bcharging\b/i.test(output)
			? "charging"
			: /\bcharged\b/i.test(output)
				? "charged"
				: "unknown";
	const estimatedRemaining = /(\d+:\d+ remaining|no estimate)/i.exec(output)?.[1];
	const battery =
		percentage === undefined && state === "unknown"
			? undefined
			: {
					...(percentage === undefined ? {} : { percentage }),
					state,
					...(estimatedRemaining === undefined ? {} : { estimatedRemaining }),
				};
	return {
		inspectionAvailable: source !== "unknown" || battery !== undefined,
		source,
		...(battery === undefined ? {} : { battery }),
		performanceContext:
			source === "battery" || state === "discharging"
				? "battery"
				: source === "ac"
					? "ac"
					: "unknown",
	};
}

function powerActivity(): PowerActivity {
	if (process.platform !== "darwin") {
		return {
			inspectionAvailable: false,
			source: "unknown",
			performanceContext: "unknown",
		};
	}
	const result = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" });
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return {
			inspectionAvailable: false,
			source: "unknown",
			performanceContext: "unknown",
		};
	}
	return parseMacPowerActivity(result.stdout);
}

function topCpuProcesses(): Pick<
	CpuActivity,
	"topProcesses" | "processInspectionAvailable"
> {
	const result = spawnSync("ps", ["-Ao", "pid=,pcpu=,comm="], { encoding: "utf8" });
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return { topProcesses: [], processInspectionAvailable: false };
	}
	const topProcesses = result.stdout
		.split("\n")
		.flatMap((line) => {
			const match = /^\s*(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
			if (match === null) return [];
			return [
				{
					pid: Number(match[1]),
					cpuPercent: Number(match[2]),
					command: match[3]!,
				},
			];
		})
		.filter((entry) => entry.cpuPercent >= 5 && entry.pid !== process.pid)
		.sort((left, right) => right.cpuPercent - left.cpuPercent)
		.slice(0, 8);
	return { topProcesses, processInspectionAvailable: true };
}

function cpuActivity(): CpuActivity {
	const logicalCpus = os.availableParallelism();
	const loadAverage1m = os.loadavg()[0] ?? 0;
	return {
		logicalCpus,
		loadAverage1m,
		loadPerCpu: logicalCpus === 0 ? 0 : loadAverage1m / logicalCpus,
		...topCpuProcesses(),
	};
}

export function shouldDeferHeavyCommand(
	activity: CpuActivity,
	activeMaligatorCommands: number,
): boolean {
	return (
		activeMaligatorCommands > 0 ||
		activity.loadPerCpu >= 0.8 ||
		activity.topProcesses.some(
			(entry) =>
				entry.cpuPercent >= 80 &&
				/(?:^|\/)(?:cc|clang|cargo|rustc|node|vitest|maligator|codex)(?:$|\s)/i.test(
					entry.command,
				),
		)
	);
}

function probeDirectory(directory: string): { ok: boolean; error?: string } {
	const probe = path.join(directory, `.maligator-write-probe-${randomUUID()}`);
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(probe, "");
		rmSync(probe, { force: true });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function inspectAgentEnvironment(workspace: string) {
	const plan = normalAgentEnvironmentPlan(workspace);
	const directories = Object.fromEntries(
		Object.entries(plan.paths).map(([name, directory]) => [
			name,
			{ path: directory, ...probeDirectory(directory) },
		]),
	);
	let loopback: { ok: boolean; error?: string };
	try {
		await assertLoopbackAvailable();
		loopback = { ok: true };
	} catch (error) {
		loopback = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const cache = inspectMaligatorCache();
	const activity = cpuActivity();
	const power = powerActivity();
	const deferHeavyCommand = shouldDeferHeavyCommand(activity, cache.activeLeases);
	return {
		schema: 2 as const,
		plan,
		capabilities: { directories, loopbackListen: loopback },
		activity: {
			...activity,
			power,
			activeMaligatorCommands: cache.activeCommands,
			recommendation: deferHeavyCommand ? "defer-heavy" : "ready",
			performanceLock: false as const,
		},
		ok: Object.values(directories).every((result) => result.ok) && loopback.ok,
	};
}

async function main(): Promise<void> {
	const json = process.argv.slice(2).includes("--json");
	const workspace = path.resolve(import.meta.dirname, "..");
	const report = await inspectAgentEnvironment(workspace);
	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`Environment: ${report.ok ? "ready" : "missing capabilities"}`);
		for (const [name, result] of Object.entries(report.capabilities.directories)) {
			console.log(`  ${result.ok ? "ok" : "blocked"} ${name}: ${result.path}`);
		}
		console.log(
			`  ${report.capabilities.loopbackListen.ok ? "ok" : "blocked"} loopback listen(0)`,
		);
		console.log(
			`CPU: ${report.activity.loadAverage1m.toFixed(2)} load / ${report.activity.logicalCpus} logical CPUs; ${report.activity.recommendation}`,
		);
		const power = report.activity.power;
		const battery = power.battery;
		const batteryDetails =
			battery === undefined
				? ""
				: `; battery ${battery.percentage === undefined ? "unknown" : `${battery.percentage}%`}, ${battery.state}${battery.estimatedRemaining === undefined ? "" : `, ${battery.estimatedRemaining}`}`;
		console.log(
			`Power: ${power.inspectionAvailable ? power.source : "inspection unavailable"}${batteryDetails}; benchmark context ${power.performanceContext}`,
		);
		for (const command of report.activity.activeMaligatorCommands) {
			console.log(`  active Maligator pid ${command.pid}: ${command.command}`);
		}
	}
	if (!report.ok) process.exitCode = 1;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
