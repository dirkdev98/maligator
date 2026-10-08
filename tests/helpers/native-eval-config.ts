import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ResolvedBuildConfig } from "../../src/build-config.ts";

/**
 * Native global setup prebuilds the shared eval compiler for exactly these feature
 * sets; an eval fixture with any other set compiles that compiler inside its timed hook.
 */
export function preparedNativeEvalConfig(node: boolean): ResolvedBuildConfig {
	return resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: true,
			regexp: true,
			realms: true,
			temporal: true,
			intl: { enabled: true, features: [] },
		},
		surface: { webPlatform: true, node },
	});
}
