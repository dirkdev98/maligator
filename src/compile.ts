import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import { referencesArguments } from "./ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "./semantic-analysis.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";

/**
 * Whether the (eval'd) program declares `arguments` at its top level — a
 * top-level `var`/`let`/`const`/`function arguments`. Used to reject declaring
 * `arguments` in a parameter-expression eval.
 */
function declaresArguments(semantic: SemanticProgram): boolean {
	const programScope = semantic.files[0]?.scopes[0];
	return (
		programScope?.bindings.some(
			(binding) => binding.name === "arguments" && !binding.undeclared,
		) ?? false
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
		 * The direct eval is in a parameter expression. Declaring `arguments` at
		 * the eval's top level then targets the parameter environment (which always
		 * binds `arguments`) — a SyntaxError. Other behavior is unaffected.
		 */
		inParamExpr?: boolean;
		/**
		 * The direct eval is inside a class field initializer, which runs with no
		 * `arguments` binding — so `arguments` in the eval'd code (outside a nested
		 * non-arrow function) is a SyntaxError (ContainsArguments early error).
		 */
		inFieldInitializer?: boolean;
	} = {},
): Uint8Array {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		options.virtualPath ?? "eval",
		undefined,
		{ eval: { callerStrict: options.callerStrict ?? false } },
	);
	if (options.inParamExpr && declaresArguments(semantic)) {
		throw new SyntaxError(
			"Declaring 'arguments' in a parameter-expression eval is not allowed",
		);
	}
	if (options.inFieldInitializer && referencesArguments(semantic.files[0]?.ast.body)) {
		throw new SyntaxError("'arguments' is not allowed in a class field initializer");
	}
	const definition = compileSemanticProgramToVmDefinition(semantic, {
		ir: {
			evalCompletion: options.completionValue,
			evalDirect: options.direct,
		},
	});
	return serializeVmDefinition(definition, { debugInfo: options.debugInfo });
}
