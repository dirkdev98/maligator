import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactOutput,
	publishArtifactAction,
	readArtifactAction,
} from "./artifact-store.ts";
import type { IncludedAsset } from "./assets.ts";
import type { BuildFrontendArtifact } from "./build-frontend-cache.ts";
import { compilerProducerIdentity } from "./compiler-cache-identity.ts";
import { deserializeCompilerArtifact } from "./compiler/target/compiler-artifact-codec.ts";
import {
	assetDataTranslationUnits,
	assetTableLines,
	DEFAULT_TRANSLATION_UNIT_POLICY,
	emitRelocatableNativeOverlayTranslationUnits,
} from "./compiler/target/emit-program-image.ts";
import type { GeneratedTranslationUnit } from "./compiler/target/emit-program-image.ts";
import { deserializeRuntimeImage } from "./compiler/target/program-image-codec.ts";
import { createConservativeNativePlan } from "./compiler/target/program-image.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";

/** Driver that splices the embedded images in order and attaches their overlays. */
export const DEVELOPMENT_FRAGMENT_MAIN = "fragment_main.c";

const FRAGMENT_UNITS_STAGE = "development-fragment-units";

function fragmentName(digest: string): string {
	if (!/^[0-9a-f]{64}$/.test(digest))
		throw new Error(`development fragment digest must be lowercase SHA-256: ${digest}`);
	return `f${digest.slice(0, 16)}`;
}

/**
 * The image an overlay is emitted from: a fragment's compiler artifact keeps the
 * native plans its compile chose; a wire alone only supports the conservative plan.
 */
function overlayImage(
	artifact: BuildFrontendArtifact,
	compilerArtifact: BuildFrontendArtifact | undefined,
): ProgramImage {
	const runtime = deserializeRuntimeImage(new Uint8Array(readFileSync(artifact.path)));
	if (compilerArtifact === undefined)
		return {
			runtime,
			native: createConservativeNativePlan(runtime.functions, runtime.stringConstants),
			diagnostics: {},
		};
	const image = deserializeCompilerArtifact(
		new Uint8Array(readFileSync(compilerArtifact.path)),
	);
	if (image.runtime.functionCount !== runtime.functionCount)
		throw new Error(`compiler artifact does not describe image ${artifact.digest}`);
	return image;
}

/**
 * Translation units for a development binary built from the same ordered images that
 * `run` loads. Each image gets a relocatable overlay that depends only on that image,
 * so an application edit leaves every dependency fragment's objects reusable. Assets
 * get a unit of their own, so editing either never recompiles the other.
 */
export function developmentFragmentUnits(
	artifacts: ReadonlyArray<BuildFrontendArtifact>,
	compilerArtifacts: ReadonlyArray<BuildFrontendArtifact> | undefined,
	entrypoint: string,
	cacheDirectory: string,
	assets: ReadonlyArray<IncludedAsset>,
): Array<GeneratedTranslationUnit> {
	if (artifacts.length === 0) throw new Error("a development program needs an image");
	if (compilerArtifacts !== undefined && compilerArtifacts.length !== artifacts.length)
		throw new Error("development fragments need one compiler artifact per image");
	const names = artifacts.map((artifact) => fragmentName(artifact.digest));
	if (new Set(names).size !== names.length)
		throw new Error("development fragments must have distinct images");
	const producer = compilerProducerIdentity(FRAGMENT_UNITS_STAGE, 4);
	const overlays = artifacts.flatMap((artifact, index) => {
		const compilerArtifact = compilerArtifacts?.[index];
		const key = artifactActionKey(producer, {
			image: artifact.digest,
			plans: compilerArtifact?.digest ?? "conservative",
			policy: DEFAULT_TRANSLATION_UNIT_POLICY,
		});
		const cached = readArtifactAction(
			cacheDirectory,
			FRAGMENT_UNITS_STAGE,
			producer,
			key,
		);
		if (cached !== undefined)
			return cached.outputs
				.filter((output) => output.name.endsWith(".json"))
				.map((output): GeneratedTranslationUnit => {
					const metadata = JSON.parse(readFileSync(output.path, "utf8")) as Omit<
						GeneratedTranslationUnit,
						"sourceChunks"
					>;
					const source = artifactOutput(cached, output.name.replace(/\.json$/, ".c"));
					return { ...metadata, sourceChunks: [readFileSync(source.path, "utf8")] };
				});
		const units = emitRelocatableNativeOverlayTranslationUnits(
			overlayImage(artifact, compilerArtifact),
			artifact.digest,
			DEFAULT_TRANSLATION_UNIT_POLICY.hardMaximumCodeUnits,
			DEFAULT_TRANSLATION_UNIT_POLICY.targetCodeUnits,
			{ kind: "fragment", name: names[index]! },
		);
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-fragment-units-"));
		try {
			// Unit source is already bounded. Keep it out of JSON, whose escaping and
			// aggregation can exceed the host engine's string limit independently.
			const publications = units.flatMap((unit, index) => {
				const { sourceChunks, ...metadata } = unit;
				const source = path.join(directory, `${index}.c`);
				const descriptor = path.join(directory, `${index}.json`);
				writeFileSync(source, sourceChunks.join(""));
				writeFileSync(descriptor, JSON.stringify(metadata));
				return [
					{ name: `${index}.json`, file: descriptor },
					{ name: `${index}.c`, file: source },
				];
			});
			publishArtifactAction(
				cacheDirectory,
				FRAGMENT_UNITS_STAGE,
				producer,
				key,
				publications,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		return units;
	});
	const table = [
		'#include "compiler_native.h"',
		'#include "dev_runner.h"',
		"",
		...names.flatMap((name) => [
			`extern const MalNativeOverlay mal_fragment_${name}_native_overlay;`,
			`extern const u8 mal_fragment_${name}_image[];`,
		]),
		"",
		"const MalDevelopmentImage mal_fragment_images[] = {",
		...artifacts.map(
			(artifact, index) =>
				`    { .bytes = mal_fragment_${names[index]}_image, .length = ${artifact.size}, .label = ${JSON.stringify(artifact.digest)}, .overlay = &mal_fragment_${names[index]}_native_overlay },`,
		),
		"};",
		`const int mal_fragment_image_count = ${artifacts.length};`,
		`const char mal_fragment_entry_path[] = ${JSON.stringify(entrypoint)};`,
	].join("\n");
	const assetTable = [
		'#include "vm.h"',
		"",
		...assetTableLines(assets, "_fragment"),
		`const MalAsset *const mal_fragment_assets = ${assets.length === 0 ? "nullptr" : "mal_assets_fragment"};`,
		`const i32 mal_fragment_asset_count = ${assets.length};`,
	].join("\n");
	// Image bytes get units of their own, keyed by content like asset bytes, so neither
	// is ever preprocessed into text and an unchanged image never recompiles.
	const images = artifacts.map((artifact, index) => {
		const symbol = `mal_fragment_${names[index]}_image`;
		const source = [
			`const unsigned char ${symbol}[] = {`,
			`#embed ${JSON.stringify(artifact.path)}`,
			"};",
			`static_assert(sizeof ${symbol} == ${artifact.size}, "development image changed after it was recorded");`,
		].join("\n");
		return {
			id: `development-fragment-image-${names[index]}`,
			kind: "data" as const,
			sourceChunks: [source],
			sourceCodeUnits: source.length,
			headerFiles: [],
			definitions: [],
			embeddedFileDigests: [artifact.digest],
		};
	});
	return [
		...overlays,
		...images,
		...assetDataTranslationUnits(assets, "_fragment").map((unit) => ({
			...unit,
			id: `development-fragment-${unit.id}`,
		})),
		{
			id: "development-fragment-images",
			kind: "data",
			sourceChunks: [table],
			sourceCodeUnits: table.length,
			headerFiles: ["compiler_native.h", "dev_runner.h"],
			definitions: [],
		},
		{
			id: "development-fragment-assets",
			kind: "data",
			sourceChunks: [assetTable],
			sourceCodeUnits: assetTable.length,
			headerFiles: ["vm.h"],
			definitions: [],
		},
	];
}
