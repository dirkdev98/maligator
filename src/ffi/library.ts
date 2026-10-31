import { readFileSync } from "node:fs";
import * as path from "node:path";
import { artifactDigest, artifactIdentity } from "../artifact-store.ts";
import { BuildConfigError } from "../build-config-error.ts";
import type { FfiModule, ResolvedBuildConfig } from "../build-config-values.ts";
import type { BuildConfigTypeStripper } from "../definition-module.ts";
import type { ExternalTranslationUnit } from "../local-build.ts";
import type { ToolExecutable } from "../toolchain.ts";
import { planBindings } from "./binding-plan.ts";
import type { BindingPlan } from "./binding-plan.ts";
import { generateBindingUnit, generateInstallerRegistry } from "./binding-unit.ts";
import type { BindingUnit } from "./binding-unit.ts";
import { FFI_C_STANDARD, extractCModel } from "./c-extract.ts";
import type { CModel } from "./c-model.ts";
import { loadLibraryContract } from "./contract.ts";
import type { LibraryContract } from "./contract.ts";
import { resolveLibrary } from "./discovery.ts";
import type { LinkInput, ResolvedLibrary } from "./discovery.ts";

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

/** Every configured library, prepared for one build. */
export interface PreparedLibraries {
	readonly libraries: ReadonlyArray<PreparedLibrary & { readonly unit: BindingUnit }>;
	/** The host modules the frontend resolves `maligator:ffi/<name>` to. */
	readonly modules: ReadonlyArray<FfiModule>;
	/** Contracts, headers, and sources; editing one requires preparing again. */
	readonly dependencies: ReadonlyArray<string>;
	/** Changes whenever a binding, header, source, or linker input changes. */
	readonly identity: string;
}

export function prepareLibraries(
	config: ResolvedBuildConfig,
	preparation: LibraryPreparation,
): PreparedLibraries {
	const libraries = Object.keys(config.ffi)
		.sort()
		.map((name) => {
			const prepared = prepareLibrary(config, name, preparation);
			return {
				...prepared,
				unit: generateBindingUnit(
					name,
					prepared.contract.headers,
					prepared.model,
					prepared.plan,
				),
			};
		});
	const dependencies = [
		...new Set(
			libraries.flatMap((entry) => [
				entry.contract.path,
				...entry.model.dependencies,
				...entry.library.sources,
			]),
		),
	].sort();
	const identity = artifactIdentity({
		libraries: libraries.map((entry) => ({
			binding: artifactDigest(entry.unit.source),
			compileArguments: entry.library.compileArguments,
			linkInputs: entry.library.linkInputs,
		})),
		files: dependencies.map((file) => [
			file,
			artifactDigest(new Uint8Array(readFileSync(file))),
		]),
	});
	return {
		libraries,
		modules: libraries.map((entry) => ({
			id: entry.unit.specifier,
			exports: entry.unit.exports,
			installer: entry.unit.installer,
		})),
		dependencies,
		identity,
	};
}

/** Unit ids allow lowercase letters, digits, `.`, `_`, and `-`. */
function unitId(...parts: ReadonlyArray<string>): string {
	return parts
		.join("-")
		.toLowerCase()
		.replaceAll(/[^a-z0-9._-]+/g, "_");
}

/**
 * The native build inputs for prepared libraries: each binding, the installer
 * registry for images loaded from the wire format, the library sources, and the
 * libraries to link. Bindings see only `mal_ffi.h` from the runtime, so library
 * headers can never shadow runtime headers.
 */
export function nativeLibraryInputs(
	prepared: PreparedLibraries,
	runtimeDirectory: string,
): { externalUnits: Array<ExternalTranslationUnit>; linkInputs: Array<LinkInput> } {
	const bindingArguments = [FFI_C_STANDARD, "-I", path.join(runtimeDirectory, "src/ffi")];
	const externalUnits: Array<ExternalTranslationUnit> = [
		{
			id: "ffi-registry",
			source: {
				text: generateInstallerRegistry(prepared.libraries.map((entry) => entry.unit)),
			},
			compileArguments: bindingArguments,
		},
	];
	for (const entry of prepared.libraries) {
		externalUnits.push({
			id: unitId("ffi", entry.contract.name, "binding"),
			source: { text: entry.unit.source },
			compileArguments: [...bindingArguments, ...entry.library.compileArguments],
		});
		entry.library.sources.forEach((source, index) => {
			externalUnits.push({
				id: unitId("ffi", entry.contract.name, String(index), path.basename(source)),
				source: { path: source },
				compileArguments: entry.library.compileArguments,
			});
		});
	}
	return {
		externalUnits,
		linkInputs: prepared.libraries.flatMap((entry) => entry.library.linkInputs),
	};
}
