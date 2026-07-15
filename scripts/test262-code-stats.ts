/**
 * Recover exact per-test VM function/instruction counts from cached interpreted
 * Test262 batch objects without recompiling or executing test code.
 *
 * Usage:
 *   node scripts/test262-code-stats.ts [--variant strict|sloppy|both] [--limit 30] [--json]
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

interface BatchManifest {
	schemaVersion?: number;
	hasBinary: boolean;
	entries: Array<{
		path: string;
		index: number;
		stats?: { functionCount: number; instructionCount: number };
	}>;
	stats: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
	};
	physical?: {
		definitionCount: number;
		functionCount: number;
		instructionCount: number;
	};
}

interface CodeStats {
	path: string;
	variant: "strict" | "sloppy";
	functionCount: number;
	instructionCount: number;
}

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const requestedVariant = argValue("--variant") ?? "strict";
if (!["strict", "sloppy", "both"].includes(requestedVariant)) {
	throw new Error(`Unsupported --variant '${requestedVariant}'`);
}

const limit = Number(argValue("--limit") ?? "30");
if (!Number.isInteger(limit) || limit <= 0) {
	throw new Error("--limit must be a positive integer");
}

const variants: Array<"strict" | "sloppy"> =
	requestedVariant === "both"
		? ["strict", "sloppy"]
		: [requestedVariant as "strict" | "sloppy"];

function inspectorSource(definitionsSymbol: string, countSymbol: string): string {
	return `
#include <stdio.h>
#include "vm.h"

extern const MalVmDefinition *const ${definitionsSymbol}[];
extern const int ${countSymbol};

int main(void) {
    for (int i = 0; i < ${countSymbol}; i++) {
        const MalVmDefinition *definition = ${definitionsSymbol}[i];
        long long instructions = 0;
        for (int f = 0; f < definition->function_count; f++) {
            instructions += definition->functions[f].instruction_count;
        }
        printf("%d\\t%d\\t%lld\\n", i, definition->function_count, instructions);
    }
    return 0;
}
`;
}

const helperSource = inspectorSource(
	"mal_test262_artifact_definitions",
	"mal_test262_artifact_definition_count",
);
const legacyHelperSource = inspectorSource(
	"mal_test262_definitions",
	"mal_test262_definition_count",
);

function recoverVariant(
	variant: "strict" | "sloppy",
	helperObject: string,
	legacyHelperObject: string,
	executable: string,
): Array<CodeStats> {
	const directory = `.cache/test262-artifacts-${variant}-interpreted`;
	if (!existsSync(directory)) {
		throw new Error(`Missing interpreted artifact cache: ${directory}`);
	}

	const results = new Map<string, CodeStats>();
	const manifests = readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort();

	for (const manifestName of manifests) {
		const stem = manifestName.slice(0, -".json".length);
		const objectPath = path.join(directory, `${stem}.o`);
		if (!existsSync(objectPath)) {
			continue;
		}

		const manifest = JSON.parse(
			readFileSync(path.join(directory, manifestName), "utf8"),
		) as BatchManifest;
		if (!manifest.hasBinary) {
			continue;
		}

		const current = manifest.schemaVersion === 2 && manifest.physical !== undefined;
		execFileSync("cc", [
			current ? helperObject : legacyHelperObject,
			objectPath,
			"-o",
			executable,
		]);
		const output = execFileSync(executable, { encoding: "utf8" }).trim();
		if (current) {
			let physicalFunctions = 0;
			let physicalInstructions = 0;
			let physicalDefinitions = 0;
			for (const line of output.length === 0 ? [] : output.split("\n")) {
				const [, rawFunctions, rawInstructions] = line.split("\t");
				physicalDefinitions++;
				physicalFunctions += Number(rawFunctions);
				physicalInstructions += Number(rawInstructions);
			}
			if (
				physicalDefinitions !== manifest.physical!.definitionCount ||
				physicalFunctions !== manifest.physical!.functionCount ||
				physicalInstructions !== manifest.physical!.instructionCount
			) {
				throw new Error(
					`${manifestName}: recovered physical ${physicalDefinitions} definitions/${physicalFunctions} functions/${physicalInstructions} instructions, expected ${manifest.physical!.definitionCount}/${manifest.physical!.functionCount}/${manifest.physical!.instructionCount}`,
				);
			}

			let logicalFunctions = 0;
			let logicalInstructions = 0;
			for (const entry of manifest.entries) {
				if (entry.stats === undefined) {
					throw new Error(`${manifestName}: missing logical entry statistics`);
				}
				logicalFunctions += entry.stats.functionCount;
				logicalInstructions += entry.stats.instructionCount;
				const candidate = {
					path: entry.path,
					variant,
					functionCount: entry.stats.functionCount,
					instructionCount: entry.stats.instructionCount,
				};
				const previous = results.get(entry.path);
				if (
					previous !== undefined &&
					(previous.functionCount !== candidate.functionCount ||
						previous.instructionCount !== candidate.instructionCount)
				) {
					throw new Error(`${entry.path}: conflicting cached code statistics`);
				}
				results.set(entry.path, candidate);
			}
			if (
				manifest.entries.length !== manifest.stats.compiledFiles ||
				logicalFunctions !== manifest.stats.functionCount ||
				logicalInstructions !== manifest.stats.instructionCount
			) {
				throw new Error(
					`${manifestName}: attributed ${manifest.entries.length} files/${logicalFunctions} functions/${logicalInstructions} instructions, expected ${manifest.stats.compiledFiles}/${manifest.stats.functionCount}/${manifest.stats.instructionCount}`,
				);
			}
			continue;
		}

		const byIndex = new Map(manifest.entries.map((entry) => [entry.index, entry.path]));
		let batchFunctions = 0;
		let batchInstructions = 0;

		for (const line of output.length === 0 ? [] : output.split("\n")) {
			const [rawIndex, rawFunctions, rawInstructions] = line.split("\t");
			const index = Number(rawIndex);
			const functionCount = Number(rawFunctions);
			const instructionCount = Number(rawInstructions);
			const testPath = byIndex.get(index);
			if (testPath === undefined) {
				throw new Error(`${manifestName}: no path for definition index ${index}`);
			}

			batchFunctions += functionCount;
			batchInstructions += instructionCount;
			const candidate = { path: testPath, variant, functionCount, instructionCount };
			const previous = results.get(testPath);
			if (
				previous !== undefined &&
				(previous.functionCount !== functionCount ||
					previous.instructionCount !== instructionCount)
			) {
				throw new Error(`${testPath}: conflicting cached code statistics`);
			}
			results.set(testPath, candidate);
		}

		if (
			batchFunctions !== manifest.stats.functionCount ||
			batchInstructions !== manifest.stats.instructionCount
		) {
			throw new Error(
				`${manifestName}: recovered ${batchFunctions} functions/${batchInstructions} instructions, expected ${manifest.stats.functionCount}/${manifest.stats.instructionCount}`,
			);
		}
	}

	return [...results.values()];
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "maligator-test262-stats-"));
try {
	const helperC = path.join(temporaryDirectory, "inspect.c");
	const helperObject = path.join(temporaryDirectory, "inspect.o");
	const legacyHelperC = path.join(temporaryDirectory, "inspect-legacy.c");
	const legacyHelperObject = path.join(temporaryDirectory, "inspect-legacy.o");
	const executable = path.join(temporaryDirectory, "inspect");
	writeFileSync(helperC, helperSource);
	writeFileSync(legacyHelperC, legacyHelperSource);
	execFileSync("cc", ["-std=c23", "-Iruntime/src", "-c", helperC, "-o", helperObject]);
	execFileSync("cc", [
		"-std=c23",
		"-Iruntime/src",
		"-c",
		legacyHelperC,
		"-o",
		legacyHelperObject,
	]);

	const recovered = variants.flatMap((variant) =>
		recoverVariant(variant, helperObject, legacyHelperObject, executable),
	);
	const ranked = recovered
		.sort((left, right) => right.instructionCount - left.instructionCount)
		.slice(0, limit);

	if (args.includes("--json")) {
		console.log(JSON.stringify(ranked, null, 2));
	} else {
		console.log("instructions\tfunctions\tvariant\tpath");
		for (const entry of ranked) {
			console.log(
				`${entry.instructionCount}\t${entry.functionCount}\t${entry.variant}\t${entry.path}`,
			);
		}
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
