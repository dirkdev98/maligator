import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ResolvedBuildConfig } from "../../src/build-config.ts";

/**
 * Native global setup prebuilds the shared eval compiler for exactly these feature
 * sets; an eval fixture with any other set compiles that compiler inside its timed hook.
 */
export function preparedNativeEvalConfig({
	node = false,
	webPlatform = true,
	realms = true,
	primordials = "mutable",
}: {
	node?: boolean;
	webPlatform?: boolean;
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
		surface: { webPlatform, node },
	});
}
