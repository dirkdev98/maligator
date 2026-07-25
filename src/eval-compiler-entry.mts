// Baked-compiler entry for runtime `eval` / `new Function` (eval Phase 3/4).
//
// maligator AOT-compiles this module (and the `compileSourceToBuffer` cone it
// pulls in: the semantic analyzer, IR pipeline, lowering, serializer, and the
// meriyah parser) into a wire definition that is `#embed`ded into the runtime
// (compiler_wire.c). On the first `eval`, the runtime splices that definition
// and runs this top level, which publishes the compile entry point as
// `globalThis.__compile`. The eval intrinsic reads it into a rooted VM slot and
// then deletes the global, so nothing leaks onto the global object.
//
// `__compile(source)` returns the same `Uint8Array` wire buffer the Node-hosted
// compiler produces (validated byte-identical by scripts/eval-selfhost-check.ts);
// the runtime loads + splices + runs it. debugInfo defaults on so eval'd frames
// carry source positions for stack traces.

import { compileSourceToBuffer } from "./compile.ts";

declare const globalThis: {
	__compile: (
		source: string,
		direct?: boolean,
		callerStrict?: boolean,
		inParamExpr?: boolean,
		inFieldInitializer?: boolean,
		directEvalContext?: string,
	) => Uint8Array;
};
declare const SyntaxError: new (message?: string) => Error;

globalThis.__compile = function __compile(
	source: string,
	direct?: boolean,
	callerStrict?: boolean,
	inParamExpr?: boolean,
	inFieldInitializer?: boolean,
	directEvalContext?: string,
): Uint8Array {
	try {
		// completionValue: eval evaluates to its last expression's value.
		// direct: free identifiers resolve against the caller scope (a with-scope
		// the direct-eval intrinsic pushes) before the global.
		// callerStrict: direct eval inherits the caller's strictness (a "use strict"
		// prologue still promotes); indirect passes false (sloppy unless directive).
		// inParamExpr: a parameter-expression eval declaring `arguments` is a
		// SyntaxError.
		return compileSourceToBuffer(source, {
			completionValue: true,
			direct,
			callerStrict,
			inParamExpr,
			inFieldInitializer,
			directEvalContext,
		});
	} catch (e) {
		// A parse / early error compiling eval source is a SyntaxError in the
		// caller's realm (per spec, eval rejects malformed source with SyntaxError).
		// Re-throw as one so `e instanceof SyntaxError` holds; the original message
		// is preserved.
		const err = e as { message?: string } | undefined;
		throw new SyntaxError(err && err.message ? err.message : String(e));
	}
};
