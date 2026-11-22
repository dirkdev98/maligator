import type { CompilerInstallation } from "./cli-commands.ts";
import {
	prepare as prepareCommand,
	prepareTests as prepareTestCommand,
} from "./compiler-service-worker.ts";
import type {
	CompilationRequest,
	CompilationTaskContext,
	TestCompilationRequest,
} from "./compiler-service.ts";
import { createProductInstallation } from "./product-installation.mts";
import type { ProductInstallationPaths } from "./product-installation.mts";

let installation: { identity: string; value: CompilerInstallation } | undefined;

function installationFor(paths: ProductInstallationPaths) {
	const identity = JSON.stringify(paths);
	if (installation === undefined || installation.identity !== identity)
		installation = { identity, value: createProductInstallation(paths) };
	return installation;
}

export function prepare(
	context: CompilationTaskContext,
	{
		installationPaths,
		...request
	}: Omit<CompilationRequest, "installation"> & {
		installationPaths: ProductInstallationPaths;
	},
) {
	const { identity, value } = installationFor(installationPaths);
	return prepareCommand(context, { ...request, installation: value }, identity);
}

export function prepareTests(
	context: CompilationTaskContext,
	{
		installationPaths,
		...request
	}: Omit<TestCompilationRequest, "installation"> & {
		installationPaths: ProductInstallationPaths;
	},
) {
	const { identity, value } = installationFor(installationPaths);
	return prepareTestCommand(context, { ...request, installation: value }, identity);
}
