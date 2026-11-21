import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ApplicationImageDescriptor } from "../application-images.ts";
import { embedDeclarationsOfWires } from "../assets.ts";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { CommandContext } from "../cli-commands.ts";
import type { EmbedDeclaration } from "../compiler/frontend/embed-declarations.ts";
import { cacheFrontendWire, frontendDigest } from "../frontend-cache.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import { UnsupportedLinkedImagesError } from "../linked-images.ts";
import type { Execution } from "../platform/execution.ts";
import { cacheDevelopmentWorkerManifest } from "../worker-image-cache.ts";
import type { NativeTestInputs } from "./application-host.ts";
import { compileTestImage, TestCompilationSession } from "./cache.ts";
import type { TestFrontendPhases } from "./cache.ts";
import { TestSourceChangedError } from "./session.ts";
import { compileLinkedTestImage } from "./test-images.ts";

export interface TestCompilationInput {
	files: Array<string>;
	config: ResolvedBuildConfig;
	execution: Execution;
	allowSupersetCache?: boolean;
	wholeImage?: boolean;
	native?: NativeTestInputs;
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
	nativeHostIdentity?: string;
	/** The `maligator:assets` declarations the test images reach. */
	embedDeclarations?: Array<EmbedDeclaration>;
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
		platformSourceRoot: context.installation.platformSourceRoot,
		session,
		dependencyWorker: context.dependencyWorker,
		runner: { kind: "application" as const },
	};
	const compile = () => {
		if (request.wholeImage) return compileTestImage(options);
		try {
			return compileLinkedTestImage(options);
		} catch (error) {
			if (!(error instanceof UnsupportedLinkedImagesError)) throw error;
			context.checkpoint?.();
			return compileTestImage(options);
		}
	};
	const compiled = compile();
	context.checkpoint?.();
	const dependencies = [...new Set(compiled.dependencies)].sort();
	const dependencyIdentities = new Map(
		session
			.dependencyIdentities(dependencies)
			.map((dependency) => [dependency.path, dependency]),
	);
	for (const dependency of request.native?.dependencies ?? []) {
		const compiled = dependencyIdentities.get(dependency.path);
		if (compiled !== undefined && compiled.digest !== dependency.digest)
			throw new TestSourceChangedError([dependency.path]);
		dependencyIdentities.set(dependency.path, dependency);
	}
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
	const embedDeclarations = embedDeclarationsOfWires(
		wires.map((wire) => readFileSync(wire.path)),
	);
	return {
		...(request.native === undefined
			? {}
			: { nativeHostIdentity: request.native.identity }),
		...(embedDeclarations.length === 0 ? {} : { embedDeclarations }),
		image: {
			schema: 2,
			wires,
			entryPath: request.files[0]!,
			workerManifestPath,
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
		dependencies: [...dependencyIdentities.keys()].sort(),
		dependencyIdentities: [...dependencyIdentities.values()],
		cache: compiled.cache,
		frontendMs: compiled.frontendMs,
		phases: compiled.phases,
		artifactHits: "artifactHits" in compiled ? compiled.artifactHits : 0,
		artifactMisses: "artifactMisses" in compiled ? compiled.artifactMisses : 0,
	};
}
