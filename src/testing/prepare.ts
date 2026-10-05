import { readFileSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { ApplicationImageDescriptor } from "../application-images.ts";
import { includeConfiguredAssets } from "../assets.ts";
import type { ResolvedBuildConfig } from "../build-config.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import type { CommandContext } from "../cli-commands.ts";
import { cacheDevelopmentAssets } from "../development-assets.ts";
import { cacheFrontendWire, frontendDigest } from "../frontend-cache.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import type { Execution } from "../platform/execution.ts";
import { cacheDevelopmentWorkerManifest } from "../worker-image-cache.ts";
import { compileTestImage, TestCompilationSession } from "./cache.ts";
import type { TestFrontendPhases } from "./cache.ts";
import {
	compileRelocatableTestImage,
	UnsupportedRelocatableTestImageError,
} from "./fragment-cache.ts";

export interface TestCompilationInput {
	files: Array<string>;
	config: ResolvedBuildConfig;
	execution: Execution;
	allowSupersetCache?: boolean;
	wholeImage?: boolean;
}

export interface PreparedTestApplication {
	image: ApplicationImageDescriptor;
	files: Array<string>;
	dependencies: Array<string>;
	dependencyIdentities: Array<FrontendDependencyIdentity>;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: TestFrontendPhases;
	artifactHits: number;
	artifactMisses: number;
}

export function prepareTestApplication(
	request: TestCompilationInput,
	context: CommandContext,
): PreparedTestApplication {
	const label = "Prepare test application";
	const started = performance.now();
	context.checkpoint?.();
	context.onCompilationPhase?.({ label, state: "started" });
	try {
		const result = prepareTestApplicationImage(request, context);
		context.checkpoint?.();
		context.onCompilationPhase?.({
			label,
			state: "completed",
			durationMs: performance.now() - started,
		});
		return result;
	} catch (error) {
		context.onCompilationPhase?.({
			label,
			state: "failed",
			durationMs: performance.now() - started,
		});
		throw error;
	}
}

function prepareTestApplicationImage(
	request: TestCompilationInput,
	context: CommandContext,
): PreparedTestApplication {
	context.checkpoint?.();
	const session = context.frontendSession ?? new TestCompilationSession();
	const options = {
		...request,
		stripTypes: context.stripTypes,
		stripperIdentity: context.installation.frontendIdentity,
		testModuleSource: readFileSync(context.installation.testModulePath, "utf8"),
		nodeGlobalsSource: readFileSync(context.installation.nodeGlobalsPath, "utf8"),
		platformSourceRoot:
			context.installation.platformSourceRoot ??
			path.dirname(context.installation.nodeGlobalsPath),
		session,
		dependencyWorker: context.dependencyWorker,
		runner: { kind: "application" as const },
	};
	const compile = () => {
		if (request.wholeImage) return compileTestImage(options);
		try {
			return compileRelocatableTestImage(options);
		} catch (error) {
			if (!(error instanceof UnsupportedRelocatableTestImageError)) throw error;
			context.checkpoint?.();
			return compileTestImage(options);
		}
	};
	const compiled = compile();
	context.checkpoint?.();
	const assets = includeConfiguredAssets(request.config.assets, process.cwd(), {
		cacheDirectory: maligatorCacheDirectory(),
		session,
	});
	const assetManifestPath = cacheDevelopmentAssets(assets);
	const dependencies = [
		...new Set([
			...compiled.dependencies,
			...assets.flatMap((asset) => asset.files.map((file) => file.inputPath)),
		]),
	].sort();
	const workerManifestPath = cacheDevelopmentWorkerManifest(
		"workerImages" in compiled ? compiled.workerImages : [],
		undefined,
		true,
	)!;
	const wires =
		"wires" in compiled
			? compiled.wires.map((wire) => ({ path: wire.path, sha256: wire.digest }))
			: [
					{
						path: cacheFrontendWire(compiled.wire),
						sha256: frontendDigest(compiled.wire),
					},
				];
	return {
		image: {
			schema: 1,
			wires,
			entryPath: request.files[0]!,
			workerManifestPath,
			...(assetManifestPath === undefined ? {} : { assetManifestPath }),
			webPlatform: request.config.surface.webPlatform,
			node: request.config.surface.node,
			engine: {
				primordials: request.config.engine.primordials,
				eval: request.config.engine.eval === true,
				realms: request.config.engine.realms,
				regexp: request.config.engine.regexp,
				temporal: request.config.engine.temporal,
				intl: request.config.engine.intl.enabled,
			},
		},
		files: request.files,
		dependencies,
		dependencyIdentities: session.dependencyIdentities(dependencies),
		cache: compiled.cache,
		frontendMs: compiled.frontendMs,
		phases: compiled.phases,
		artifactHits: "artifactHits" in compiled ? compiled.artifactHits : 0,
		artifactMisses: "artifactMisses" in compiled ? compiled.artifactMisses : 0,
	};
}
