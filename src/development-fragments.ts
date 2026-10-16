import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
} from "./artifact-store.ts";
import type { BuildFrontendArtifact } from "./build-frontend-cache.ts";
import { compilerImplementationDigest } from "./compiler-cache-identity.ts";
import {
	DEFAULT_TRANSLATION_UNIT_POLICY,
	emitRelocatableNativeOverlayTranslationUnits,
} from "./compiler/target/emit-program-image.ts";
import type { GeneratedTranslationUnit } from "./compiler/target/emit-program-image.ts";
import { deserializeRuntimeImage } from "./compiler/target/program-image-codec.ts";
import { createConservativeNativePlan } from "./compiler/target/program-image.ts";

/** Driver that splices the embedded images in order and attaches their overlays. */
export const DEVELOPMENT_FRAGMENT_MAIN = "fragment_main.c";

const FRAGMENT_UNITS_STAGE = "development-fragment-units";

function fragmentName(digest: string): string {
	if (!/^[0-9a-f]{64}$/.test(digest))
		throw new Error(`development fragment digest must be lowercase SHA-256: ${digest}`);
	return `f${digest.slice(0, 16)}`;
}

/**
 * Translation units for a development binary built from the same ordered images that
 * `run` loads. Each image gets a relocatable overlay that depends only on that image,
 * so an application edit leaves every dependency fragment's objects reusable.
 */
export function developmentFragmentUnits(
	artifacts: ReadonlyArray<BuildFrontendArtifact>,
	entrypoint: string,
	cacheDirectory: string,
): Array<GeneratedTranslationUnit> {
	if (artifacts.length === 0) throw new Error("a development program needs an image");
	const names = artifacts.map((artifact) => fragmentName(artifact.digest));
	if (new Set(names).size !== names.length)
		throw new Error("development fragments must have distinct images");
	const producer = artifactProducer(
		FRAGMENT_UNITS_STAGE,
		1,
		compilerImplementationDigest(),
	);
	const overlays = artifacts.flatMap((artifact, index) => {
		const key = artifactActionKey(producer, {
			image: artifact.digest,
			policy: DEFAULT_TRANSLATION_UNIT_POLICY,
		});
		const cached = readArtifactAction(
			cacheDirectory,
			FRAGMENT_UNITS_STAGE,
			producer,
			key,
		);
		if (cached !== undefined)
			return JSON.parse(
				readFileSync(artifactOutput(cached, "units.json").path, "utf8"),
			) as Array<GeneratedTranslationUnit>;
		const runtime = deserializeRuntimeImage(new Uint8Array(readFileSync(artifact.path)));
		const units = emitRelocatableNativeOverlayTranslationUnits(
			{
				runtime,
				native: createConservativeNativePlan(runtime.functions, runtime.stringConstants),
				diagnostics: {},
			},
			artifact.digest,
			DEFAULT_TRANSLATION_UNIT_POLICY.hardMaximumCodeUnits,
			DEFAULT_TRANSLATION_UNIT_POLICY.targetCodeUnits,
			{ kind: "fragment", name: names[index]! },
		);
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-fragment-units-"));
		try {
			const file = path.join(directory, "units.json");
			writeFileSync(file, JSON.stringify(units));
			publishArtifactAction(cacheDirectory, FRAGMENT_UNITS_STAGE, producer, key, [
				{ name: "units.json", file },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		return units;
	});
	const table = [
		'#include "compiler_native.h"',
		'#include "dev_runner.h"',
		"",
		...names.map(
			(name) => `extern const MalNativeOverlay mal_fragment_${name}_native_overlay;`,
		),
		"",
		...artifacts.flatMap((artifact, index) => [
			`static const u8 mal_fragment_image_${index}[] = {`,
			`#embed ${JSON.stringify(artifact.path)}`,
			"};",
		]),
		"",
		"const MalDevelopmentImage mal_fragment_images[] = {",
		...artifacts.map(
			(artifact, index) =>
				`    { .bytes = mal_fragment_image_${index}, .length = sizeof mal_fragment_image_${index}, .label = ${JSON.stringify(artifact.digest)}, .overlay = &mal_fragment_${names[index]}_native_overlay },`,
		),
		"};",
		`const int mal_fragment_image_count = ${artifacts.length};`,
		`const char mal_fragment_entry_path[] = ${JSON.stringify(entrypoint)};`,
	].join("\n");
	return [
		...overlays,
		{
			id: "development-fragment-images",
			kind: "data",
			source: table,
			headerFiles: ["compiler_native.h", "dev_runner.h"],
			definitions: [],
		},
	];
}
