import { BuildConfigError } from "../../build-config-error.ts";
import type { ResolvedBuildConfig } from "../../build-config.ts";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import { collectPrimordialMutationDiagnostics } from "./primordial-diagnostics.ts";
import type { DisallowedEvalUsage, DisallowedRegexpUsage } from "./semantic-analysis.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";

export function validateSemanticBuildPolicy(
	semantic: SemanticProgram,
	config: ResolvedBuildConfig,
	world: WorldFacts,
) {
	assertEvalPolicy(config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(config, collectDisallowedRegexpUsage(semantic));
	return collectPrimordialMutationDiagnostics(semantic, world, {
		nodeEnabled: config.surface.node,
	});
}

export function assertEvalPolicy(
	config: ResolvedBuildConfig,
	usages: Array<DisallowedEvalUsage>,
): void {
	if (config.engine.eval !== "compile-check" || usages.length === 0) return;
	const sites = usages
		.map((usage) => {
			const call = usage.kind === "eval" ? "eval(...)" : "new Function(...)";
			return `  ${call} at ${usage.path}:${usage.line}:${usage.column}`;
		})
		.join("\n");
	throw new BuildConfigError(
		`dynamic code is rejected by your build config (engine.eval is "compile-check"):\n${sites}\n` +
			`Use { engine: { eval: false } } to defer these sites to the runtime EvalError gate, ` +
			`or { engine: { eval: true } } to enable eval / new Function.`,
	);
}

export function assertRegexpPolicy(
	config: ResolvedBuildConfig,
	usages: Array<DisallowedRegexpUsage>,
): void {
	if (config.engine.regexp || usages.length === 0) return;
	const sites = usages
		.map((usage) => {
			const what = usage.kind === "literal" ? "regex literal /…/" : "new RegExp(...)";
			return `  ${what} at ${usage.path}:${usage.line}:${usage.column}`;
		})
		.join("\n");
	throw new BuildConfigError(
		`RegExp is disabled by your build config (engine.regexp is false):\n${sites}\n` +
			`Remove { engine: { regexp: false } } from maligator.build.ts to use RegExp (it is on by default).`,
	);
}
