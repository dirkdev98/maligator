import { existsSync } from "node:fs";
import * as path from "node:path";
import { loadAndAnalyze } from "./semantic-analysis.ts";
import { log } from "./utils.ts";

const entrypoint = process.argv[2];

if (!entrypoint || !existsSync(entrypoint)) {
	log.info(`Usage: maligator [./entyproint.js]`);
	process.exit(1);
}

const entrypointPath = path.resolve(entrypoint);

const semTiming = log.time("semantic analysis");
const semanticProgram = loadAndAnalyze(entrypointPath);
semTiming();

log.debug(semanticProgram, 4);
