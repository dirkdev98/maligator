import { hash } from "node:crypto";
import { createWorkerUrl } from "maligator:workers";
import { resolveBuildConfig } from "../../../src/build-config.ts";
import { stripCompactTypes } from "../../../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../../../src/compiler/frontend/module-graph.ts";
import type { ModuleGraph } from "../../../src/compiler/frontend/module-graph.ts";
import { captureRootInputs } from "../../../src/compiler/root-compilation.ts";
import { serializeCompilerArtifact } from "../../../src/compiler/target/compiler-artifact-codec.ts";
import { startNativeRootCompilation } from "../../../src/native-root-compiler.ts";

const largeEntry = createWorkerUrl("./large-worker.mts", import.meta.url);
const earlyEntry = createWorkerUrl("./early-worker.mts", import.meta.url);
const failedEntry = createWorkerUrl("./failed-worker.mts", import.meta.url);
const orderedEntry = createWorkerUrl("./ordered-worker.mts", import.meta.url);
const cancelledEntry = createWorkerUrl("./cancelled-worker.mts", import.meta.url);
const config = resolveBuildConfig({
	engine: { eval: false, regexp: false },
	surface: { node: false, webPlatform: false },
});
const options = {
	stripTypes: stripCompactTypes,
	buildConfig: config,
	optimization: "full" as const,
};
const mal = Reflect.get(globalThis, "mal") as unknown as {
	_applicationResources(): { processWorkers: number };
};
const joined = () => mal._applicationResources().processWorkers;
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function graphFor(count = 1): ModuleGraph {
	const paths = Array.from({ length: count }, (_, index) => `/unused-root-${index}.mts`);
	return {
		entry: paths[0]!,
		modules: new Map(),
		nodeEnabled: false,
		evaluationOrder: [],
		cycles: [],
		workerEntries: paths.map((file) => ({
			path: file,
			href: `file://${file}`,
			importer: paths[0]!,
		})),
	};
}

const large = startNativeRootCompilation(graphFor(), options, [], {
	concurrency: 1,
	entry: largeEntry,
});
let payload: Uint8Array | undefined;
try {
	await large.result;
	throw new Error("large report should throw");
} catch (error) {
	check(
		error instanceof TypeError && error.message === "large root report",
		"large typed failure",
	);
	payload = (error as TypeError & { payload: Uint8Array }).payload;
	check(payload.byteLength === 35 * 1024 * 1024, "large report byte length");
}
await large.close();
check(joined() === 0, "large report joined");
check(payload !== undefined, "large payload present");
const largeDigest = hash("sha256", payload, "hex");

const failed = startNativeRootCompilation(graphFor(), options, [], {
	concurrency: 1,
	entry: failedEntry,
});
let failedUndefined = false;
try {
	await failed.result;
} catch (error) {
	failedUndefined = error === undefined;
}
await failed.close();
check(failedUndefined && joined() === 0, "startup throw undefined joins");

const early = startNativeRootCompilation(graphFor(), options, [], {
	concurrency: 1,
	entry: earlyEntry,
});
let earlyFailed = false;
try {
	await early.result;
} catch (error) {
	earlyFailed = error instanceof Error;
}
await early.close();
check(earlyFailed && joined() === 0, "early exit settles and joins");

const ordered = startNativeRootCompilation(graphFor(2), options, [], {
	concurrency: 2,
	entry: orderedEntry,
});
let orderedFailed = false;
try {
	await ordered.result;
} catch (error) {
	orderedFailed = error instanceof TypeError && error.message === "earlier";
}
await ordered.close();
check(orderedFailed && joined() === 0, "declaration failure order joins both");

const cancelled = startNativeRootCompilation(graphFor(2), options, [], {
	concurrency: 2,
	entry: cancelledEntry,
});
cancelled.cancel(null);
let cancelledNull = false;
try {
	await cancelled.result;
} catch (error) {
	cancelledNull = error === null;
}
await cancelled.close();
check(
	cancelledNull && joined() === 0,
	"cooperative cancellation drains with exact reason",
);

const entrypoint = process.argv[2]!;
const graph = buildModuleGraph(entrypoint, {
	buildConfig: config,
	stripTypes: stripCompactTypes,
});
const actual = startNativeRootCompilation(graph, options, captureRootInputs(graph), {
	concurrency: 2,
});
const result = await actual.result;
await actual.close();
check(joined() === 0, "actual compiler roots joined");
process.stdout.write(
	`${JSON.stringify({
		largeDigest,
		roots: result.workers.map((worker) => ({
			href: worker.entry.href,
			compiler: hash("sha256", serializeCompilerArtifact(worker.image), "hex"),
			wire: hash("sha256", worker.wire, "hex"),
		})),
		diagnostics: result.diagnostics,
	})}\nroot transport PASS\n`,
);
