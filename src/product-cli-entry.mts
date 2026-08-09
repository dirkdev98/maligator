import { dirname } from "node:path";
import { productCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";

const { assets } = Reflect.get(globalThis, "mal") as {
	assets: { materialize(name: string): string };
};
const mal = Reflect.get(globalThis, "mal") as unknown as {
	_spawnDevelopmentProcess(executablePath: string, args: Array<string>): number;
	_killDevelopmentProcess(handle: number, force: boolean): void;
	_developmentProcessStatus(handle: number): number | undefined;
	_waitDevelopmentChange(directories: Array<string>, timeoutMs: number): void;
};

interface ProductDevelopmentWatcher {
	directories: Array<string>;
}

function updateDevelopmentDirectories(
	handle: ProductDevelopmentWatcher,
	files: Array<string>,
): void {
	handle.directories = [...new Set(files.map((file) => dirname(file)))];
}

await runCli(process.argv.slice(2), {
	stripTypes: stripCompactTypes,
	installation: productCompilerInstallation(
		assets.materialize("runtime"),
		assets.materialize("compilerWire"),
		assets.materialize("testRuntime"),
		assets.materialize("license"),
		process.argv[0],
		assets.materialize("testNodeGlobals"),
	),
	developmentProcesses: {
		spawn: (executablePath, args) => mal._spawnDevelopmentProcess(executablePath, args),
		kill: (handle, force) =>
			mal._killDevelopmentProcess(handle as number, force === true),
		status: (handle) => mal._developmentProcessStatus(handle as number),
	},
	developmentWatcher: {
		create(files) {
			const handle: ProductDevelopmentWatcher = { directories: [] };
			updateDevelopmentDirectories(handle, files);
			return handle;
		},
		update(handle, files) {
			updateDevelopmentDirectories(handle as ProductDevelopmentWatcher, files);
		},
		wait(handle, timeoutMs) {
			mal._waitDevelopmentChange(
				(handle as ProductDevelopmentWatcher).directories,
				timeoutMs,
			);
			return new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
		},
		close() {},
	},
	dependencyWorker: { tool: process.argv[0]!, args: [] },
});
