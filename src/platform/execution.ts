import type { Execution, ExecutionTarget } from "maligator:process";
import type { ResolvedBuildConfig } from "../build-config-values.ts";
import type { BuildCommand, DevCommand, RunCommand, TestCommand } from "../cli.ts";
import {
	lookupPlatformModule,
	PLATFORM_CATALOG_VERSION,
	validatePlatformValue,
} from "./catalog.ts";
import type { PlatformData } from "./catalog.ts";

export type { Execution, ExecutionTarget } from "maligator:process";

export interface ExecutionPlan {
	readonly compiled: boolean;
	readonly optimization: "development" | "full";
	readonly target: ExecutionTarget;
}

function freezeData<Value>(value: Value): Value {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeData(child);
		Object.freeze(value);
	}
	return value;
}

/** Canonical property ordering makes provider data independent of config insertion order. */
function canonicalData(value: PlatformData): PlatformData {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalData);
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => [key, canonicalData(item)]),
	);
}

export function executionData(execution: Execution): PlatformData {
	const module = lookupPlatformModule("maligator:process")!;
	if (!validatePlatformValue(module, module.exports[0]!.type, execution)) {
		throw new Error("Invalid application execution description");
	}
	return canonicalData(execution);
}

export function executionIdentity(execution: Execution | undefined): string {
	return JSON.stringify([
		PLATFORM_CATALOG_VERSION,
		execution === undefined ? null : executionData(execution),
	]);
}

export function resolveExecution(
	command: BuildCommand | RunCommand | DevCommand | TestCommand,
	config: ResolvedBuildConfig,
	plan: ExecutionPlan,
	shuffleSeed: number | null = null,
): Execution {
	const profile =
		command.profileCompiler === true ? "compiler" : command.profile ? "sampling" : "none";
	const common = {
		production: command.kind === "build" && command.production,
		compiled: plan.compiled,
		optimization: plan.optimization,
		target: { ...plan.target },
		config: {
			engine: {
				...config.engine,
				intl: {
					...config.engine.intl,
					features: [...config.engine.intl.features],
					languages: [...config.engine.intl.languages],
				},
			},
			surface: { webPlatform: config.surface.webPlatform, node: config.surface.node },
			modules: { aliases: { ...config.modules.aliases } },
		},
	};
	let execution: Execution;
	if (command.kind === "test") {
		const seed = typeof command.shuffle === "number" ? command.shuffle : shuffleSeed;
		if (command.shuffle !== undefined && seed === null)
			throw new Error("Resolve the test shuffle seed before compilation");
		execution = {
			...common,
			command: "test",
			options: {
				profile,
				nameFilter: command.nameFilter ?? null,
				repeat: command.repeat,
				bail: command.bail,
				timeoutMs: command.timeoutMs,
				shuffleSeed: command.shuffle === undefined ? null : seed,
			},
		};
	} else execution = { ...common, command: command.kind, options: { profile } };
	return freezeData(executionData(execution)) as Execution;
}

export function executionTarget(triple: string): ExecutionTarget {
	const targets: Record<string, ExecutionTarget> = {
		"aarch64-apple-darwin": { platform: "darwin", arch: "arm64", triple },
		"x86_64-apple-darwin": { platform: "darwin", arch: "x64", triple },
		"aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", triple },
		"x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", triple },
		"wasm32-wasip1": { platform: "wasi", arch: "wasm32", triple },
	};
	const target = targets[triple];
	if (target === undefined) throw new Error(`Unsupported execution target: ${triple}`);
	return target;
}
