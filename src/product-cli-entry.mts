import { productCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";

const { assets } = Reflect.get(globalThis, "mal") as {
	assets: { materialize(name: string): string };
};
const mal = Reflect.get(globalThis, "mal") as unknown as {
	_spawnDevelopmentProcess(executablePath: string, args: Array<string>): number;
	_killDevelopmentProcess(handle: number, force: boolean): void;
	_developmentProcessStatus(handle: number): number | undefined;
};

await runCli(process.argv.slice(2), {
	stripTypes: stripCompactTypes,
	installation: productCompilerInstallation(
		assets.materialize("runtime"),
		assets.materialize("compilerWire"),
		assets.materialize("testRuntime"),
		assets.materialize("license"),
		process.argv[0],
	),
	developmentProcesses: {
		spawn: (executablePath, args) => mal._spawnDevelopmentProcess(executablePath, args),
		kill: (handle, force) =>
			mal._killDevelopmentProcess(handle as number, force === true),
		status: (handle) => mal._developmentProcessStatus(handle as number),
	},
});
