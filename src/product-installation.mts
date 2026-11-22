import { join } from "node:path";
import { productCompilerInstallation } from "./cli-commands.ts";
import {
	compilerWire,
	license,
	platformSources,
	runtime,
	testHost,
	testRuntime,
	thirdPartyNotices,
} from "./product-assets.mts";

export interface ProductInstallationPaths {
	executablePath: string;
	temporaryDirectory: string;
}

export function createProductInstallation(paths: ProductInstallationPaths) {
	const options = { baseDirectory: paths.temporaryDirectory };
	return productCompilerInstallation(
		() => runtime.materialize(options),
		() => compilerWire.materialize(options),
		() => testRuntime.materialize(options),
		[() => license.materialize(options), () => thirdPartyNotices.materialize(options)],
		paths.executablePath,
		() => platformSources.materialize(options),
		() => join(testHost.materialize(options), "host-driver.mts"),
	);
}
