import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ResolvedBuildConfig } from "../../src/build-config.ts";

/**
 * Native global setup prebuilds the shared eval compiler for exactly these feature
 * sets; an eval fixture with any other set compiles that compiler inside its timed hook.
 */
export function preparedNativeEvalConfig({
	realms = true,
	primordials = "mutable",
}: {
	realms?: boolean;
	primordials?: "mutable" | "locked";
} = {}): ResolvedBuildConfig {
	return resolveBuildConfig({
		engine: {
			primordials,
			eval: true,
			regexp: true,
			realms,
			temporal: true,
			intl: { enabled: true, features: [] },
		},
	});
}

/**
 * The eval-enabled product defaults, prepared for builds launched by native tests.
 */
export function defaultProductEvalConfig(): ResolvedBuildConfig {
	return resolveBuildConfig({ engine: { eval: true } });
}

export function owningArgumentForwardingEvalConfig(
	primordials: "mutable" | "locked",
): ResolvedBuildConfig {
	return resolveBuildConfig({
		engine: { primordials, eval: true, realms: false, intl: { enabled: false } },
	});
}
