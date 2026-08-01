import { productCompilerInstallation, runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";

const { assets } = Reflect.get(globalThis, "mal") as {
	assets: { materialize(name: string): string };
};

runCli(process.argv.slice(2), {
	stripTypes: stripCompactTypes,
	installation: productCompilerInstallation(
		assets.materialize("runtime"),
		assets.materialize("compilerWire"),
		assets.materialize("license"),
	),
});
