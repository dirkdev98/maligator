import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import { emitWorkerImageTranslationUnits } from "../src/compiler/target/emit-worker-images.ts";

test("worker roots survive a frontend cache hit independently of parent runtime fragments", () => {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-worker-cache-"));
	try {
		const entrypoint = path.join(root, "main.mjs");
		const worker = path.join(root, "worker.mjs");
		writeFileSync(
			entrypoint,
			'import { Worker } from "node:worker_threads"; globalThis.worker = new Worker(new URL("./worker.mjs", import.meta.url));',
		);
		writeFileSync(worker, "globalThis.workerResult = 42;");
		const options = {
			entrypoint,
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: (source: string) => source,
			stripperIdentity: "worker-cache-fixture",
			cacheDirectory: path.join(root, "cache"),
			optimization: "development" as const,
			relocatable: true,
		};
		const first = compileBuildFrontend(options);
		expect(first.cache).toBe("miss");
		expect(first.runtimeArtifacts).toHaveLength(1);
		expect(first.workerImages).toHaveLength(1);
		expect(first.dependencies).toContain(worker);
		const restored = compileBuildFrontend(options);
		expect(restored.cache).toBe("hit");
		expect(restored.workerImages[0]!.wire).toEqual(first.workerImages[0]!.wire);
		expect(restored.workerImages[0]!.image.runtime.entrypointPath).toBe(worker);
		const registry = emitWorkerImageTranslationUnits(restored.workerImages).find(
			(unit) => unit.id === "worker-registry",
		)!;
		expect(registry.source).toContain(
			`mal_runtime_image_worker_${restored.workerImages[0]!.id}`,
		);
		writeFileSync(worker, "globalThis.workerResult = 43;");
		const changed = compileBuildFrontend(options);
		expect(changed.cache).toBe("miss");
		expect(changed.workerImages[0]!.wire).not.toEqual(restored.workerImages[0]!.wire);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
