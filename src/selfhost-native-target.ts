import { resolveBuildConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import type { GeneratedTranslationUnit } from "./compiler/target/emit-program-image.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import { nativeSourcePath } from "./native-source-path.ts";

/** The program configuration the self-hosted native compiler builds. */
export function selfhostNativeTargetConfig(evalEnabled: boolean): ResolvedBuildConfig {
	return resolveBuildConfig({
		engine: {
			eval: evalEnabled,
			realms: false,
			regexp: false,
			intl: { enabled: false },
		},
		surface: { webPlatform: false, node: false, maligator: true },
	});
}

export const SELFHOST_NATIVE_FRONTEND = { stripTypes: stripCompactTypes } as const;
export const SELFHOST_NATIVE_EMISSION = {
	sourcePath: nativeSourcePath,
	maligatorSurface: true,
} as const;

// The artifact codec would push the self-hosted compiler past Node's default heap while
// it compiles itself; plain JSON covers the plan contract without extra compiler code.
function nativePlanJson(definition: ProgramImage): string {
	return JSON.stringify(definition.native, (_, value: unknown) => {
		if (
			value instanceof Map ||
			value instanceof Set ||
			ArrayBuffer.isView(value) ||
			typeof value === "bigint"
		)
			throw new Error("Native plan evidence supports only plain JSON values");
		return value;
	});
}

/** Files both compiler hosts must reproduce byte for byte: native plans and emitted C. */
export function selfhostNativeEvidence(
	definition: ProgramImage,
	translationUnits: ReadonlyArray<GeneratedTranslationUnit>,
): ReadonlyArray<{ readonly name: string; readonly bytes: string }> {
	return [
		{ name: "native-plans.json", bytes: `${nativePlanJson(definition)}\n` },
		{
			name: "units.json",
			bytes: `${JSON.stringify(
				translationUnits.map(({ id, kind, headerFiles }) => ({ id, kind, headerFiles })),
			)}\n`,
		},
		...translationUnits.map((unit) => ({ name: `${unit.id}.c`, bytes: unit.source })),
	];
}
