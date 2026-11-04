import { rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { compileRootBatch } from "../../../src/compiler/root-compilation-kernel.ts";
import type { RootBatch } from "../../../src/compiler/root-compilation.ts";

const batch = workerData as RootBatch;
writeFileSync(
	path.join(path.dirname(batch.jobs[0]!.entry.path), "handoff-directory"),
	batch.artifactDirectory,
);
const result = compileRootBatch(batch);
const file = path.join(batch.artifactDirectory, `${batch.jobs[0]!.index}.malw`);
const mode = path.basename(batch.jobs[0]!.entry.path, ".mts");
if (mode === "corrupt") writeFileSync(file, "invalid artifact");
else if (mode === "missing") rmSync(file);
parentPort!.postMessage(result);
parentPort!.close();
