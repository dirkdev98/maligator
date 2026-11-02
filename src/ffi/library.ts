import { readFileSync } from "node:fs";
import * as path from "node:path";
import { artifactDigest, artifactIdentity } from "../artifact-store.ts";
import { BuildConfigError } from "../build-config-error.ts";
import type { FfiModule, ResolvedBuildConfig } from "../build-config-values.ts";
import { platformCcFlags } from "../build-flags.ts";
import type { BuildConfigTypeStripper } from "../definition-module.ts";
import type { ExternalTranslationUnit } from "../local-build.ts";
import type { ToolExecutable } from "../toolchain.ts";
import { planBindings } from "./binding-plan.ts";
import type { BindingPlan } from "./binding-plan.ts";
import { generateBindingUnit, generateInstallerRegistry } from "./binding-unit.ts";
import type { BindingUnit } from "./binding-unit.ts";
import { FFI_C_STANDARD, extractCSourceDependencies } from "./c-extract.ts";
import type { CModel } from "./c-model.ts";
import { loadLibraryContract } from "./contract.ts";
import type { LibraryContract } from "./contract.ts";
import { resolveLibrary } from "./discovery.ts";
import type { LinkInput, ResolvedLibrary } from "./discovery.ts";
import { FfiError } from "./ffi-error.ts";
import { loadCModel } from "./model-cache.ts";

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
	readonly onDependencies?: (files: ReadonlyArray<string>) => void;
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
	preparation.onDependencies?.([path.resolve(preparation.projectRoot, entry.contract)]);
	const contract = loadLibraryContract(
		name,
		entry,
		preparation.projectRoot,
		preparation.stripTypes,
	);
	preparation.onDependencies?.(
		contract.find.flatMap((find) => [
			...find.includeDirs,
			...find.libraryDirs,
			...find.sources,
			...contract.headers.flatMap((header) =>
				path.isAbsolute(header)
					? [header]
					: find.includeDirs.map((directory) => path.join(directory, header)),
			),
		]),
	);
	const library = resolveLibrary(contract, {
		environment: preparation.environment,
		platform: preparation.platform,
		cross: preparation.cross,
	});
	preparation.onDependencies?.(
		library.linkInputs.flatMap((input) =>
			input.kind === "archive" || input.kind === "shared" ? [input.path] : [],
		),
	);
	const extraction = {
		compiler: preparation.compiler,
		environment: preparation.environment,
		compileArguments: [
			...platformCcFlags(preparation.platform),
			...library.compileArguments,
		],
		onDependencies: preparation.onDependencies,
	};
	const extracted = loadCModel({ ...extraction, headers: contract.headers });
	const model: CModel = {
		...extracted,
		dependencies: [
			...new Set([
				...extracted.dependencies,
				...library.sources.flatMap((source) =>
					extractCSourceDependencies(extraction, source),
				),
			]),
		].sort(),
	};
	let plan: BindingPlan;
	try {
		plan = planBindings(model, contract.facts);
	} catch (error) {
		if (error instanceof FfiError) {
			throw new FfiError(
				`${path.relative(preparation.projectRoot, contract.path)}: ${error.message}`,
			);
		}
		throw error;
	}
	return { contract, library, model, plan };
}

/** Every configured library, prepared for one build. */
export interface PreparedLibraries {
	readonly libraries: ReadonlyArray<PreparedLibrary & { readonly unit: BindingUnit }>;
	/** The host modules the frontend resolves `maligator:ffi/<name>` to. */
	readonly modules: ReadonlyArray<FfiModule>;
	/** Contracts, headers, sources and resolved library files that invalidate native hosts. */
	readonly dependencies: ReadonlyArray<string>;
	/** Changes whenever a binding, header, source, or linker input changes. */
	readonly identity: string;
}

export function prepareLibraries(
	config: ResolvedBuildConfig,
	preparation: LibraryPreparation,
): PreparedLibraries {
	const prepared = Object.keys(config.ffi)
		.sort()
		.map((name) => prepareLibrary(config, name, preparation));
	// A shared C dependency can call a callback registered through another library.
	const hasCallbacks = prepared.some((entry) => entry.plan.hasCallbacks);
	const libraries = prepared.map((entry) => {
		const plan = { ...entry.plan, hasCallbacks };
		return {
			...entry,
			plan,
			unit: generateBindingUnit(
				entry.contract.name,
				entry.contract.headers,
				entry.model,
				plan,
			),
		};
	});
	const dependencies = [
		...new Set(
			libraries.flatMap((entry) => [
				entry.contract.path,
				...entry.model.dependencies,
				...entry.library.sources,
				...entry.library.linkInputs.flatMap((input) =>
					input.kind === "archive" || input.kind === "shared" ? [input.path] : [],
				),
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
			direct: entry.unit.direct,
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
