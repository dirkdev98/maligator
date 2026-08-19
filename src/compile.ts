import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import { decodeDirectEvalContext } from "./direct-eval-context.ts";
import { referencesArguments } from "./semantic-lowering.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "./semantic-analysis.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";

/** VarDeclaredNames of the eval script, represented by its hoisted Program bindings. */
function varDeclaredNames(semantic: SemanticProgram): Set<string> {
	const programScope = semantic.files[0]?.scopes[0];
	return new Set(
		programScope?.bindings
			.filter(
				(binding) =>
					binding.kind === "var" && !binding.undeclared && binding.implicit === undefined,
			)
			.map((binding) => binding.name) ?? [],
	);
}

/**
 * Compile a single JavaScript script source into the binary definition wire
 * format (serialize-vm.ts) — the `mal_vm_load_definition` / `mal_vm_splice_definition`
 * input. This is the trimmed compiler entry that runtime `eval` runs: the script
 * front end (no module graph / bundler / native-C backend / disk build), then
 * lower + serialize. The same function is what gets self-hosted and exposed to
 * the running VM as `__compile` (eval Phase 3); on Node it is also the
 * programmatic equivalent of `index.ts --serialize` for a source string.
 *
 * Script mode (indirect eval / Function body): no ESM import/export. Strict
 * mode matches the implied-strict pipeline.
 */
export function compileSourceToBuffer(
	source: string,
	options: {
		virtualPath?: string;
		debugInfo?: boolean;
		completionValue?: boolean;
		direct?: boolean;
		/**
		 * Whether the eval call is contained in strict-mode code. Direct eval
		 * inherits the caller's strictness; indirect eval passes false. Combined
		 * with a "use strict" prologue to decide the eval source's strictness.
		 */
		callerStrict?: boolean;
		/**
		 * Retained as a positional compatibility slot in the baked `__compile` ABI.
		 * Parameter-environment conflicts are carried by `directEvalContext`.
		 */
		inParamExpr?: boolean;
		/**
		 * The direct eval is inside a class field initializer, which runs with no
		 * `arguments` binding — so `arguments` in the eval'd code (outside a nested
		 * non-arrow function) is a SyntaxError (ContainsArguments early error).
		 */
		inFieldInitializer?: boolean;
		/** Encoded inherited method/private syntax and identity shape for direct eval. */
		directEvalContext?: string;
	} = {},
): Uint8Array {
	const directEvalContext = decodeDirectEvalContext(options.directEvalContext);
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		options.virtualPath ?? "eval",
		undefined,
		{
			eval: {
				callerStrict: options.callerStrict ?? false,
				direct: options.direct ?? false,
				directEvalContext,
			},
		},
	);
	if (options.direct && !semantic.files[0]?.strict) {
		const conflictNames = new Set(directEvalContext.varConflictNames);
		const conflict = [...varDeclaredNames(semantic)].find((name) =>
			conflictNames.has(name),
		);
		if (conflict !== undefined) {
			throw new SyntaxError(`Eval var declaration conflicts with '${conflict}'`);
		}
	}
	if (options.inFieldInitializer && referencesArguments(semantic.files[0]?.ast.body)) {
		throw new SyntaxError("'arguments' is not allowed in a class field initializer");
	}
	const definition = compileSemanticProgramToVmDefinition(semantic, {
		semanticLowering: {
			evalCompletion: options.completionValue,
			evalDirect: options.direct,
			directEvalContext,
		},
	});
	return serializeVmDefinition(definition, { debugInfo: options.debugInfo });
}
