import { BuildConfigError } from "../build-config-error.ts";
import type { ResolvedBuildConfig } from "../build-config-values.ts";
import type { BuildConfigTypeStripper } from "../definition-module.ts";
import type { ToolExecutable } from "../toolchain.ts";
import { planBindings } from "./binding-plan.ts";
import type { BindingPlan } from "./binding-plan.ts";
import { extractCModel } from "./c-extract.ts";
import type { CModel } from "./c-model.ts";
import { loadLibraryContract } from "./contract.ts";
import type { LibraryContract } from "./contract.ts";
import { resolveLibrary } from "./discovery.ts";
import type { ResolvedLibrary } from "./discovery.ts";

/** A configured C library after discovery, header extraction, and mapping. */
export interface PreparedLibrary {
	readonly contract: LibraryContract;
	readonly library: ResolvedLibrary;
	readonly model: CModel;
	readonly plan: BindingPlan;
}

export interface LibraryPreparation {
	readonly projectRoot: string;
	readonly stripTypes: BuildConfigTypeStripper;
	/** The target's C compiler; header extraction needs clang or `zig cc`. */
	readonly compiler: ToolExecutable;
	readonly environment: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	readonly cross: boolean;
}

export function prepareLibrary(
	config: ResolvedBuildConfig,
	name: string,
	preparation: LibraryPreparation,
): PreparedLibrary {
	const entry = config.ffi[name];
	if (entry === undefined) {
		const configured = Object.keys(config.ffi);
		throw new BuildConfigError(
			`no ffi library '${name}' in maligator.build.ts${configured.length === 0 ? "" : ` (configured: ${configured.join(", ")})`}`,
		);
	}
	const contract = loadLibraryContract(
		name,
		entry,
		preparation.projectRoot,
		preparation.stripTypes,
	);
	const library = resolveLibrary(contract, {
		environment: preparation.environment,
		platform: preparation.platform,
		cross: preparation.cross,
	});
	const model = extractCModel({
		compiler: preparation.compiler,
		environment: preparation.environment,
		headers: contract.headers,
		compileArguments: library.compileArguments,
	});
	return { contract, library, model, plan: planBindings(model) };
}
