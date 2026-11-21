import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { collectEmbeddedAssets } from "../src/assets.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	embedModuleDeclaration,
	isEmbedModule,
} from "../src/compiler/frontend/embed-declarations.ts";
import { SOURCE_HOST_MODULES } from "../src/compiler/frontend/host-modules.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { productCliConfig } from "../src/product-builder.ts";

it("packages every source platform module the installed compiler reads", () => {
	const sourceRoot = path.resolve(import.meta.dirname, "../src");
	const graph = buildModuleGraph(path.join(sourceRoot, "product-assets.mts"), {
		buildConfig: productCliConfig("compiler.malw", "producer-digests.json", "runner"),
		stripTypes: stripCompactTypes,
	});
	const declarations = [...graph.modules.keys()]
		.filter(isEmbedModule)
		.map(embedModuleDeclaration);
	const sourceTrees = declarations.filter(
		({ kind, path: directory }) => kind === "directory" && directory === sourceRoot,
	);
	const required = new Set(SOURCE_HOST_MODULES.values());
	for (const platformModule of PLATFORM_MODULES) {
		if (platformModule.kind === "source") {
			// The product installs the test runtime from its own embedded file.
			if (platformModule.id === "maligator:test") {
				expect(declarations).toContainEqual(
					expect.objectContaining({
						kind: "file",
						path: path.join(sourceRoot, platformModule.sourceFile),
					}),
				);
			} else {
				required.add(platformModule.sourceFile);
			}
		}
		for (const entry of platformModule.exports) {
			if (entry.contract.workerSource !== undefined)
				required.add(entry.contract.workerSource);
		}
	}
	const cacheDirectory = mkdtempSync(path.join(tmpdir(), "mal-product-assets-"));
	try {
		const assets = collectEmbeddedAssets(sourceTrees, {
			cacheDirectory,
			session: new FrontendCompilationSession(),
		});
		const shipped = new Set(
			assets.flatMap(({ files }) => files.map((file) => file.path)),
		);
		expect([...required].filter((file) => !shipped.has(file))).toEqual([]);
	} finally {
		rmSync(cacheDirectory, { recursive: true, force: true });
	}
});
