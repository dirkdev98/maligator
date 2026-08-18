import * as os from "node:os";
import * as path from "node:path";
import {
	cargoCacheDirectory,
	maligatorBuildDirectory,
	maligatorCacheDirectory,
	npmCacheDirectory,
} from "../src/cache-root.ts";

export type CommandCpuClass = "light" | "heavy" | "performance-sensitive";
export type CommandKind =
	| "quality"
	| "unit"
	| "compiler"
	| "native"
	| "standards"
	| "rust";

export interface CommandRequirements {
	cpu: CommandCpuClass;
	capabilities: {
		workspaceWrite: boolean;
		temporaryWrite: boolean;
		userCacheWrite: boolean;
		npmCacheWrite: boolean;
		cargoCacheWrite: boolean;
		loopbackListen: boolean;
		outboundNetwork: boolean;
		processInspection: boolean;
	};
}

export interface CommandEnvironmentPlan {
	schema: 1;
	approval: "none" | "explicit";
	requirements: CommandRequirements;
	paths: {
		workspace: string;
		temporary: string;
		buildOutput: string;
		maligatorCache: string;
		npmCache: string;
		cargoCache: string;
	};
	coordination: {
		inspectCpuBeforeHeavyWork: true;
		deferWhenBusy: true;
		performanceLock: false;
	};
}

export function requirementsForCommand(kind: CommandKind): CommandRequirements {
	const native = kind === "native" || kind === "standards";
	const rust = kind === "rust" || native;
	const builds = kind === "compiler" || native || rust;
	return {
		cpu: builds ? "heavy" : "light",
		capabilities: {
			workspaceWrite: kind !== "quality",
			temporaryWrite: kind !== "quality",
			userCacheWrite: builds,
			npmCacheWrite: true,
			cargoCacheWrite: rust,
			loopbackListen: native,
			outboundNetwork: false,
			processInspection: builds,
		},
	};
}

export function mergeCommandRequirements(
	items: ReadonlyArray<CommandRequirements>,
): CommandRequirements {
	const capabilityNames = Object.keys(
		requirementsForCommand("quality").capabilities,
	) as Array<keyof CommandRequirements["capabilities"]>;
	return {
		cpu: items.some((item) => item.cpu === "performance-sensitive")
			? "performance-sensitive"
			: items.some((item) => item.cpu === "heavy")
				? "heavy"
				: "light",
		capabilities: Object.fromEntries(
			capabilityNames.map((name) => [
				name,
				items.some((item) => item.capabilities[name]),
			]),
		) as CommandRequirements["capabilities"],
	};
}

export function commandEnvironmentPlan(
	requirements: CommandRequirements,
	options: { approval?: "none" | "explicit"; workspace?: string } = {},
): CommandEnvironmentPlan {
	const workspace = path.resolve(options.workspace ?? process.cwd());
	return {
		schema: 1,
		approval: options.approval ?? "none",
		requirements,
		paths: {
			workspace,
			temporary: os.tmpdir(),
			buildOutput: maligatorBuildDirectory(workspace),
			maligatorCache: maligatorCacheDirectory(),
			npmCache: npmCacheDirectory(),
			cargoCache: cargoCacheDirectory(),
		},
		coordination: {
			inspectCpuBeforeHeavyWork: true,
			deferWhenBusy: true,
			performanceLock: false,
		},
	};
}

export function normalAgentEnvironmentPlan(
	workspace = process.cwd(),
): CommandEnvironmentPlan {
	return commandEnvironmentPlan(requirementsForCommand("native"), { workspace });
}
