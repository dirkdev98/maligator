import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectMaligatorCache } from "../src/cache-management.ts";
import { normalAgentEnvironmentPlan } from "./command-requirements.ts";
import { assertLoopbackAvailable } from "./test-environment.ts";

export interface CpuActivity {
	logicalCpus: number;
	loadAverage1m: number;
	loadPerCpu: number;
	topProcesses: Array<{ pid: number; cpuPercent: number; command: string }>;
	processInspectionAvailable: boolean;
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

export function cpuActivity(): CpuActivity {
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
		activity.topProcesses.some((entry) => entry.cpuPercent >= 80)
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

export async function inspectAgentEnvironment(workspace: string) {
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
	const deferHeavyCommand = shouldDeferHeavyCommand(activity, cache.activeLeases);
	return {
		schema: 1 as const,
		plan,
		capabilities: { directories, loopbackListen: loopback },
		activity: {
			...activity,
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
