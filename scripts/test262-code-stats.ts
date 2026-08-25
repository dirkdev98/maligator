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
import { maligatorCacheDirectory } from "../src/cache-root.ts";

interface BatchManifest {
	schemaVersion: 2;
	hasBinary: boolean;
	entries: Array<{
		path: string;
		index: number;
		stats: { functionCount: number; instructionCount: number };
	}>;
	stats: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
	};
	physical: {
		imageCount: number;
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

function inspectorSource(imagesSymbol: string, countSymbol: string): string {
	return `
#include <stdio.h>
#include "vm.h"

extern const MalRuntimeImage *const ${imagesSymbol}[];
extern const int ${countSymbol};

int main(void) {
    for (int i = 0; i < ${countSymbol}; i++) {
        const MalRuntimeImage *image = ${imagesSymbol}[i];
        long long instructions = 0;
        for (int f = 0; f < image->function_count; f++) {
            instructions += image->functions[f].instruction_count;
        }
        printf("%d\\t%d\\t%lld\\n", i, image->function_count, instructions);
    }
    return 0;
}
`;
}

const helperSource = inspectorSource(
	"mal_test262_artifact_images",
	"mal_test262_artifact_image_count",
);
function recoverVariant(
	variant: "strict" | "sloppy",
	helperObject: string,
	executable: string,
): Array<CodeStats> {
	const directory = path.join(
		maligatorCacheDirectory(),
		"test262-artifacts",
		`${variant}-interpreted`,
	);
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
		if (manifest.schemaVersion !== 2 || !manifest.hasBinary) {
			continue;
		}

		execFileSync("cc", [helperObject, objectPath, "-o", executable]);
		const output = execFileSync(executable, { encoding: "utf8" }).trim();
		let physicalFunctions = 0;
		let physicalInstructions = 0;
		let physicalImages = 0;
		for (const line of output.length === 0 ? [] : output.split("\n")) {
			const [, rawFunctions, rawInstructions] = line.split("\t");
			physicalImages++;
			physicalFunctions += Number(rawFunctions);
			physicalInstructions += Number(rawInstructions);
		}
		if (
			physicalImages !== manifest.physical.imageCount ||
			physicalFunctions !== manifest.physical.functionCount ||
			physicalInstructions !== manifest.physical.instructionCount
		) {
			throw new Error(
				`${manifestName}: recovered physical ${physicalImages} images/${physicalFunctions} functions/${physicalInstructions} instructions, expected ${manifest.physical.imageCount}/${manifest.physical.functionCount}/${manifest.physical.instructionCount}`,
			);
		}

		let logicalFunctions = 0;
		let logicalInstructions = 0;
		for (const entry of manifest.entries) {
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
	}

	return [...results.values()];
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "maligator-test262-stats-"));
try {
	const helperC = path.join(temporaryDirectory, "inspect.c");
	const helperObject = path.join(temporaryDirectory, "inspect.o");
	const executable = path.join(temporaryDirectory, "inspect");
	writeFileSync(helperC, helperSource);
	execFileSync("cc", ["-std=c23", "-Iruntime/src", "-c", helperC, "-o", helperObject]);

	const recovered = variants.flatMap((variant) =>
		recoverVariant(variant, helperObject, executable),
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
