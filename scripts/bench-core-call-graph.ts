import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
	CORE_ANY_SCRIPT_AGGREGATE,
	updateCoreCallGraph,
} from "../src/compiler/core/core-call-graph.ts";
import type { CoreCallGraphRow } from "../src/compiler/core/core-call-graph.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";

const FUNCTION_COUNT = 1_000;
const WILDCARD_COUNT = 100;
const ITERATIONS = 20;
const SAMPLES = 9;
const functions = Array.from(
	{ length: FUNCTION_COUNT },
	(_, index) => index as CoreFunctionId,
);
const rows: ReadonlyArray<CoreCallGraphRow> = functions.map((caller, index) => ({
	caller,
	exactTargets: [],
	wildcard: index < WILDCARD_COUNT,
}));
const graph = updateCoreCallGraph(undefined, functions, rows);
const functionStates = Uint16Array.from(
	functions,
	(functionId) => 1 << (functionId % 12),
);
let blackhole = 0;

function symbolic(): number {
	const graph = updateCoreCallGraph(undefined, functions, rows);
	const reached = new Uint8Array(FUNCTION_COUNT);
	const queue: Array<number> = [functions[0]!];
	reached[0] = 1;
	let reachedFunctions = 1;
	let aggregateReached = false;
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const node = queue[cursor]!;
		graph.visitSuccessors(node as CoreFunctionId, (successor) => {
			if (successor === CORE_ANY_SCRIPT_AGGREGATE) {
				if (aggregateReached) return;
				aggregateReached = true;
				queue.push(successor);
				return;
			}
			if (reached[successor] !== 0) return;
			reached[successor] = 1;
			reachedFunctions++;
			queue.push(successor);
		});
	}
	return reachedFunctions;
}

function expanded(): number {
	const outgoing = Array.from({ length: FUNCTION_COUNT }, () => new Array<number>());
	for (const row of rows) {
		if (row.wildcard) {
			for (const callee of functions) outgoing[row.caller]!.push(callee);
		} else {
			outgoing[row.caller]!.push(...row.exactTargets);
		}
	}
	const reached = new Uint8Array(FUNCTION_COUNT);
	const queue: Array<CoreFunctionId> = [functions[0]!];
	reached[0] = 1;
	for (let cursor = 0; cursor < queue.length; cursor++) {
		for (const callee of outgoing[queue[cursor]!]!) {
			if (reached[callee] !== 0) continue;
			reached[callee] = 1;
			queue.push(callee as CoreFunctionId);
		}
	}
	return queue.length;
}

function symbolicReversePropagation(): number {
	let aggregate = 0;
	for (const functionId of functions) aggregate |= functionStates[functionId]!;
	let checksum = 0;
	for (const caller of graph.wildcardCallers) checksum += aggregate ^ caller;
	return checksum;
}

function expandedReversePropagation(): number {
	const callerStates = new Uint16Array(WILDCARD_COUNT);
	for (const functionId of functions) {
		for (const caller of graph.wildcardCallers) {
			callerStates[caller] = callerStates[caller]! | functionStates[functionId]!;
		}
	}
	let checksum = 0;
	for (const caller of graph.wildcardCallers) checksum += callerStates[caller]! ^ caller;
	return checksum;
}

function measure(run: () => number): number {
	const startedAt = performance.now();
	for (let iteration = 0; iteration < ITERATIONS; iteration++) blackhole ^= run();
	return (performance.now() - startedAt) / ITERATIONS;
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)]!;
}

for (let index = 0; index < 20; index++) {
	blackhole ^= symbolic();
	blackhole ^= expanded();
	blackhole ^= symbolicReversePropagation();
	blackhole ^= expandedReversePropagation();
}
const symbolicSamples: Array<number> = [];
const expandedSamples: Array<number> = [];
const symbolicReverseSamples: Array<number> = [];
const expandedReverseSamples: Array<number> = [];
for (let sample = 0; sample < SAMPLES; sample++) {
	if (sample % 2 === 0) {
		symbolicSamples.push(measure(symbolic));
		expandedSamples.push(measure(expanded));
		symbolicReverseSamples.push(measure(symbolicReversePropagation));
		expandedReverseSamples.push(measure(expandedReversePropagation));
	} else {
		expandedSamples.push(measure(expanded));
		symbolicSamples.push(measure(symbolic));
		expandedReverseSamples.push(measure(expandedReversePropagation));
		symbolicReverseSamples.push(measure(symbolicReversePropagation));
	}
}
if (symbolic() !== expanded()) throw new Error("Reachability checksum mismatch");
if (symbolicReversePropagation() !== expandedReversePropagation()) {
	throw new Error("Reverse-propagation checksum mismatch");
}
const symbolicMedianMs = median(symbolicSamples);
const expandedMedianMs = median(expandedSamples);
const speedup = expandedMedianMs / symbolicMedianMs;
const symbolicReverseMedianMs = median(symbolicReverseSamples);
const expandedReverseMedianMs = median(expandedReverseSamples);
const reverseSpeedup = expandedReverseMedianMs / symbolicReverseMedianMs;
const report = {
	schemaVersion: 2,
	recordedAt: new Date().toISOString(),
	commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	node: process.version,
	v8: process.versions.v8,
	host: `${os.platform()} ${os.release()} ${os.arch()} ${os.cpus()[0]?.model ?? "unknown"}`,
	fixture: {
		functions: FUNCTION_COUNT,
		wildcardCallers: WILDCARD_COUNT,
		iterationsPerSample: ITERATIONS,
		samples: SAMPLES,
	},
	result: {
		symbolicMedianMs,
		expandedMedianMs,
		speedup,
		symbolicSamples,
		expandedSamples,
		checksum: FUNCTION_COUNT,
		blackhole,
		reversePropagation: {
			symbolicMedianMs: symbolicReverseMedianMs,
			expandedMedianMs: expandedReverseMedianMs,
			speedup: reverseSpeedup,
			symbolicSamples: symbolicReverseSamples,
			expandedSamples: expandedReverseSamples,
			checksum: symbolicReversePropagation(),
		},
	},
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
	const output = process.argv[outputIndex + 1];
	if (output === undefined) throw new Error("Expected a path after --output");
	writeFileSync(output, `${JSON.stringify(report, undefined, "\t")}\n`);
}
console.log(JSON.stringify(report, undefined, "\t"));
if (speedup < 4 || reverseSpeedup < 4) process.exitCode = 1;
