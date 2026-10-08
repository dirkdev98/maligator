import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import type { BuildDerivation, ResolvedBuildConfig } from "./build-config.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { compileEntrypoint } from "./compiler/pipeline/compile-program.ts";
import { serializeCompilerArtifact } from "./compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import type { GeneratedTranslationUnit } from "./compiler/target/emit-program-image.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import { nativeSourcePath } from "./native-source-path.ts";

export interface SelfhostNativeTarget {
	readonly config: ResolvedBuildConfig;
	readonly derivation: BuildDerivation;
	readonly definition: ProgramImage;
	readonly translationUnits: ReadonlyArray<GeneratedTranslationUnit>;
}

/** Compile one entrypoint exactly as the self-hosted native compiler does. */
export function compileSelfhostNativeTarget(
	inputPath: string,
	evalEnabled: boolean,
): SelfhostNativeTarget {
	const config = resolveBuildConfig({
		engine: {
			eval: evalEnabled,
			realms: false,
			regexp: false,
			intl: { enabled: false },
		},
		surface: { webPlatform: false, node: false, maligator: true },
	});
	const definition = compileEntrypoint(path.resolve(inputPath), {
		stripTypes: stripCompactTypes,
		buildConfig: config,
	});
	return {
		config,
		derivation: buildDerivationFromConfig(config),
		definition,
		translationUnits: emitProgramTranslationUnits(definition, {
			sourcePath: nativeSourcePath,
			maligatorSurface: true,
		}),
	};
}

/** Files both compiler hosts must reproduce byte for byte: native plans and emitted C. */
export function selfhostNativeEvidence(
	target: SelfhostNativeTarget,
): ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array | string }> {
	return [
		{ name: "program.malc", bytes: serializeCompilerArtifact(target.definition) },
		{
			name: "units.json",
			bytes: `${JSON.stringify(
				target.translationUnits.map(({ id, kind, headerFiles }) => ({
					id,
					kind,
					headerFiles,
				})),
			)}\n`,
		},
		...target.translationUnits.map((unit) => ({
			name: `${unit.id}.c`,
			bytes: unit.source,
		})),
	];
}
