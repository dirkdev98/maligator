import type { ResolvedBuildConfig } from "../../build-config.ts";
import type {
	ClosureOpening,
	ClosureRoot,
	ClosureRootKind,
	ProgramClosureCertificate,
} from "../shared/compiler-facts.ts";
import { programClosureCertificate } from "../shared/compiler-facts.ts";
import type { ModuleDependency, ModuleGraph, ModuleRecord } from "./module-graph.ts";

/**
 * Build-mode inputs the module graph cannot see. Both are required: an omitted
 * capability would silently certify a program the host can still extend.
 */
export interface ClosureEnvironment {
	/**
	 * The artifact is one island of a larger image (relocatable fragments, or the
	 * packaged development runner that splices them), so its graph is not the
	 * program and whole-program closure is unavailable.
	 */
	readonly relocatableArtifact: boolean;
	/**
	 * The executing host exposes the development wire API (`mal._runWire`,
	 * `mal._runWirePath`, `--maligator-internal-run-wire`), which splices wire
	 * images the compiler never saw into the running VM.
	 */
	readonly hostWireSplicing: boolean;
}

/**
 * Derive the program's closure certificate from a real module graph.
 *
 * Roots are every module the image can enter; openings are every reason the
 * enumeration might be incomplete. Closure is claimed only when the artifact is
 * a whole program and no opening admits source the compiler never saw.
 */
export function certifyProgramClosure(
	graph: ModuleGraph,
	config: ResolvedBuildConfig,
	environment: ClosureEnvironment,
): ProgramClosureCertificate {
	return programClosureCertificate(
		environment.relocatableArtifact
			? { kind: "fragment", entry: graph.entry }
			: { kind: "whole-program", entry: graph.entry },
		enumerateRoots(graph),
		enumerateOpenings(graph, config, environment),
	);
}

/**
 * One root per graph module, entry first and then evaluation order, so the list
 * is a deterministic function of the graph rather than of map insertion order.
 */
function enumerateRoots(graph: ModuleGraph): Array<ClosureRoot> {
	const evaluated = new Set(graph.evaluationOrder);
	const roots: Array<ClosureRoot> = [];
	const seen = new Set<string>();
	const add = (modulePath: string): void => {
		const record = graph.modules.get(modulePath);
		if (record === undefined || seen.has(modulePath)) return;
		seen.add(modulePath);
		roots.push({ kind: rootKind(graph, record, evaluated), module: modulePath });
	};
	add(graph.entry);
	for (const modulePath of graph.evaluationOrder) add(modulePath);
	for (const modulePath of [...graph.modules.keys()].sort()) add(modulePath);
	return roots;
}

function rootKind(
	graph: ModuleGraph,
	record: ModuleRecord,
	evaluated: ReadonlySet<string>,
): ClosureRootKind {
	if (record.path === graph.entry) return "entry-module";
	if (record.host !== undefined) return "host-module";
	if (record.virtual === true) return "virtual-module";
	if (evaluated.has(record.path)) return "static-module";
	// Present in the graph but outside the static evaluation order: the image can
	// only enter it through `import()`, so it is its own root.
	return "dynamic-module";
}

function enumerateOpenings(
	graph: ModuleGraph,
	config: ResolvedBuildConfig,
	environment: ClosureEnvironment,
): Array<ClosureOpening> {
	const openings: Array<ClosureOpening> = [];
	if (config.engine.eval === true) {
		openings.push({
			kind: "dynamic-code",
			detail:
				"engine.eval is true, so the embedded compiler can turn runtime strings into new functions",
		});
	}
	if (environment.hostWireSplicing) {
		openings.push({
			kind: "host-wire-splicing",
			detail:
				"the executing host exposes the development wire API, which splices unseen wire images into the running VM",
		});
	}
	if (environment.relocatableArtifact) {
		openings.push({
			kind: "relocatable-artifact",
			detail:
				"a relocatable artifact is one island of a larger image, so this graph is not the whole program",
		});
	}
	for (const modulePath of [...graph.modules.keys()].sort()) {
		const record = graph.modules.get(modulePath)!;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath !== null) continue;
			openings.push({ module: modulePath, ...dependencyOpening(dependency) });
		}
	}
	return openings;
}

/**
 * Classify a dependency the graph could not resolve. Every shape the graph
 * currently produces is lowered to a bounded, in-image behaviour, so none of them
 * admit new source; the unmodelled default stays conservative for future kinds.
 */
function dependencyOpening(
	dependency: ModuleDependency,
): Pick<ClosureOpening, "kind" | "detail"> {
	if (dependency.specifier === null) {
		return dependency.kind === "dynamic"
			? {
					kind: "computed-module-specifier",
					detail:
						"import(expression) lowers to an equality chain over the graph's dynamic-import targets and a rejecting fallback",
				}
			: {
					kind: "computed-module-specifier",
					detail:
						"require(expression) lowers to the CommonJS require intrinsic, which rejects a non-identifier argument",
				};
	}
	if (dependency.kind === "dynamic") {
		return {
			kind: "unresolved-module-target",
			detail: `dynamic import of '${dependency.specifier}' has no build-time target and lowers to a rejecting import`,
		};
	}
	if (dependency.catchableMissing === true) {
		return {
			kind: "unresolved-module-target",
			detail: `require('${dependency.specifier}') has no build-time target and lowers to a MODULE_NOT_FOUND throw`,
		};
	}
	return {
		kind: "unresolved-runtime-load",
		detail: `${dependency.kind} of '${dependency.specifier}' resolved to no target and has no modelled runtime behaviour`,
	};
}
