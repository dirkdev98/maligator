import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as LoadedModule3 from "../src/build-config.ts";
import type * as LoadedModule4 from "../src/compiler/frontend/compact-type-strip.ts";
import type * as LoadedModule1 from "../src/compiler/pipeline/compile-program.ts";
import type * as LoadedModule2 from "../src/compiler/target/emit-program-image.ts";

const [source, input, output] = process.argv.slice(2);
if (source === undefined || input === undefined || output === undefined) {
	throw new Error("usage: bench-quick-compiler SOURCE INPUT OUTPUT");
}
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { compileEntrypoint } = (await load(
	"src/compiler/pipeline/compile-program.ts",
)) as typeof LoadedModule1;
const { emitProgramTranslationUnits } = (await load(
	"src/compiler/target/emit-program-image.ts",
)) as typeof LoadedModule2;
const { resolveBuildConfig } = (await load(
	"src/build-config.ts",
)) as typeof LoadedModule3;
const { stripCompactTypes } = (await load(
	"src/compiler/frontend/compact-type-strip.ts",
)) as typeof LoadedModule4;
const image = compileEntrypoint(input, {
	buildConfig: resolveBuildConfig({
		engine: { eval: false, realms: false, intl: { enabled: false } },
		surface: { webPlatform: false, node: true, maligator: true },
	}),
	stripTypes: stripCompactTypes,
	coreInstrumentation: "off",
});
const units = emitProgramTranslationUnits(image, { maligatorSurface: true });
mkdirSync(output, { recursive: true });
for (const [index, unit] of units.entries()) {
	writeFileSync(path.join(output, `unit-${index}.c`), unit);
}
console.log(
	JSON.stringify({
		units: units.length,
		codeUnits: units.reduce((sum, unit) => sum + unit.length, 0),
	}),
);
