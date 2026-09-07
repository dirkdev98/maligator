import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBuildConfig, resolveBuildConfig } from "../src/build-config.ts";
import { requireWasmToolchain } from "../src/toolchain.ts";
import { buildWasmEngine, probeWasmToolchain } from "../src/wasm-build.ts";

const { values } = parseArgs({
	options: {
		doctor: { type: "boolean" },
		entry: { type: "string" },
		config: { type: "string" },
		output: { type: "string" },
		help: { type: "boolean" },
	},
});
if (values.help === true) {
	console.log(
		"Build an engine-only wasm32-wasip1 reactor.\nUsage: npm run wasm:build -- [--entry file] [--config file] [--output file.wasm]\nDoctor: npm run wasm:doctor",
	);
} else if (values.doctor === true) {
	const toolchain = requireWasmToolchain(process.cwd());
	mkdirSync(".cache", { recursive: true });
	probeWasmToolchain(process.cwd(), toolchain);
	console.log(JSON.stringify({ ...toolchain, reactorProbe: "passed" }, null, 2));
} else {
	const config =
		values.config === undefined
			? resolveBuildConfig({
					engine: {
						eval: false,
						realms: false,
						regexp: true,
						temporal: false,
						intl: { enabled: false },
					},
					surface: { webPlatform: false, node: false, maligator: false },
				})
			: loadBuildConfig(values.config);
	const result = buildWasmEngine({
		root: process.cwd(),
		entry: values.entry ?? config.entry ?? "src/explorer/wasm-entry.mts",
		config,
		output: path.resolve(values.output ?? ".cache/wasm/explorer.wasm"),
		onProgress: (message) => console.log(`[wasm] ${message}`),
	});
	console.log(result.file);
}
