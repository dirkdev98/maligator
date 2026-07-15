import { writeFileSync } from "node:fs";
import { stripCompactTypes } from "./compact-type-strip.ts";
import { compileEntrypointToBuffer } from "./compile-program.ts";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (inputPath === undefined || outputPath === undefined) {
	throw new Error("usage: selfhost-frontend <input> <output>");
}

const bytes = compileEntrypointToBuffer(inputPath, {
	stripTypes: stripCompactTypes,
	buildConfig: {
		entry: undefined,
		outputName: undefined,
		assets: {},
		engine: {
			eval: false,
			realms: false,
			regexp: true,
			intl: { enabled: false, features: [], languages: [] },
		},
		host: { scheduler: "single" },
		surface: { webPlatform: false, node: true, maligator: true },
	},
});
writeFileSync(outputPath, bytes);
