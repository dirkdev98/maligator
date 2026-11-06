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

/**
 * The runtime `maligator build` resolves for an application that enables only eval and
 * the Node surface. Native global setup prebuilds it for product builds of such configs.
 */
export function defaultNodeEvalConfig(): ResolvedBuildConfig {
	return resolveBuildConfig({ engine: { eval: true }, surface: { node: true } });
}
