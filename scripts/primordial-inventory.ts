import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseCliArgs } from "../src/cli.ts";
import { HOST_MODULES } from "../src/compiler/frontend/host-modules.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { hostExecutionTarget, resolveExecution } from "../src/platform/execution.ts";
import { buildNativeProgramImage } from "../src/test-harness.ts";
import { writePrimordialInventoryDriver } from "../tests/helpers/primordial-inventory.ts";
import { primordialInventoryConfig } from "./primordial-inventory-config.ts";
import { normalizePrimordialInventory } from "./primordial-inventory-data.ts";

export function capturePrimordialInventory(mode: string, outDir: string) {
	mkdirSync(outDir, { recursive: true });
	const config = primordialInventoryConfig(mode);
	const modules = [
		...(config.surface.node ? HOST_MODULES.keys() : []),
		...PLATFORM_MODULES.filter((module) => module.kind === "native").map(
			(module) => module.id,
		),
	];
	const fixture = path.join(outDir, `inventory-${mode}.mjs`);
	writeFileSync(
		fixture,
		modules
			.map(
				(id, index) =>
					`import * as module${index} from ${JSON.stringify(id)};\nglobalThis.module${index} = module${index};`,
			)
			.join("\n"),
	);
	const mainFile = writePrimordialInventoryDriver(outDir);
	const command = parseCliArgs(["build", fixture]);
	if (command.kind !== "build") throw new Error("Expected build command");
	const image = compileEntrypoint(fixture, {
		buildConfig: config,
		execution: resolveExecution(command, config, {
			compiled: true,
			optimization: "full",
			target: hostExecutionTarget(process.platform, process.arch),
		}),
	});
	const binary = buildNativeProgramImage(image, {
		name: `inventory-${mode}`,
		mainFile,
		outDir,
		config,
		profileEnabled: mode === "diagnostic",
		environment: { ...process.env, MAL_PERF_STATS: mode === "diagnostic" ? "1" : "0" },
	});
	execFileSync(binary, ["--check-no-getter"], { stdio: "ignore", timeout: 60_000 });
	const output = path.join(outDir, `inventory-${mode}.jsonl`);
	const jsonl = execFileSync(binary, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: {
			PATH: "/usr/bin:/bin",
			LANG: "C",
			TZ: "UTC",
			...(mode === "diagnostic"
				? {
						MAL_HOST_GC: "1",
						MAL_GC_STATS: "1",
						MAL_GC_CONTROL: "1",
						MAL_ALLOC_FAIL_TEST: "1",
						MAL_PERF_STATS: "1",
						MAL_PERF_CONTROL: "1",
					}
				: {}),
		},
	});
	writeFileSync(output, jsonl);
	writeFileSync(
		path.join(outDir, `inventory-${mode}.json`),
		`${JSON.stringify(
			normalizePrimordialInventory(jsonl, image.runtime.hostInstalls),
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		path.join(outDir, `inventory-${mode}-config.json`),
		`${JSON.stringify(
			{ config, binary, hostInstalls: image.runtime.hostInstalls },
			null,
			2,
		)}\n`,
	);
	return {
		phases: normalizePrimordialInventory(jsonl, image.runtime.hostInstalls),
		config,
	};
}

if (process.argv[1]?.endsWith("/primordial-inventory.ts")) {
	const mode = process.argv[2];
	if (mode === undefined)
		throw new Error(
			"Usage: node scripts/primordial-inventory.ts MODE [output-directory]",
		);
	const outDir = path.resolve(process.argv[3] ?? ".cache/primordial-inventory");
	capturePrimordialInventory(mode, outDir);
	console.log(path.join(outDir, `inventory-${mode}.jsonl`));
}
