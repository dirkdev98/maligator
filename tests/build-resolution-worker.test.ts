import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import type { CompiledBuildFrontend } from "../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";

function runtimeImages(frontend: CompiledBuildFrontend) {
	return [frontend.wire, ...frontend.workerImages.map((worker) => worker.wire)];
}

it.each([false, true])(
	"re-resolves a nearer package for worker root: %s",
	(worker) => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-build-resolution-worker-"));
		try {
			const originalPackage = path.join(root, "node_modules/located");
			mkdirSync(originalPackage, { recursive: true });
			writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
			writeFileSync(path.join(originalPackage, "package.json"), '{"main":"index.js"}\n');
			writeFileSync(path.join(originalPackage, "index.js"), 'module.exports = "old";\n');
			const nested = path.join(root, "nested");
			mkdirSync(nested);
			const consumer = path.join(nested, "consumer.mjs");
			writeFileSync(consumer, 'import value from "located"; console.log(value);\n');
			const entrypoint = worker ? path.join(root, "entry.mjs") : consumer;
			if (worker)
				writeFileSync(
					entrypoint,
					'import { createWorkerUrl } from "maligator:workers"; console.log(createWorkerUrl("./nested/consumer.mjs", import.meta.url));\n',
				);
			const options = {
				entrypoint,
				cacheDirectory: path.join(root, "cache"),
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "resolution-nearer-package",
				session: new BuildCompilationSession(),
			};
			const before = compileBuildFrontend(options);
			expect(compileBuildFrontend(options).cache).toBe("hit");
			const packageDirectory = path.join(nested, "node_modules/located");
			mkdirSync(packageDirectory, { recursive: true });
			writeFileSync(path.join(packageDirectory, "package.json"), '{"main":"index.js"}\n');
			writeFileSync(path.join(packageDirectory, "index.js"), 'module.exports = "new";\n');
			const changed = compileBuildFrontend(options);
			expect(changed.cache).toBe("miss");
			expect(runtimeImages(changed)).not.toEqual(runtimeImages(before));
			expect(compileBuildFrontend(options).cache).toBe("hit");
			expect(
				runtimeImages(compileBuildFrontend({ ...options, forceCompile: true })),
			).toEqual(runtimeImages(changed));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);
