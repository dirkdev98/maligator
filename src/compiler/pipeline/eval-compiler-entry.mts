// Baked-compiler entry for runtime `eval` / `new Function` (eval Phase 3/4).
//
// maligator AOT-compiles this module (and the `compileSourceToBuffer` cone it
// pulls in: the semantic analyzer, IR pipeline, lowering, serializer, and the
// meriyah parser) into a runtime-image wire payload that is `#embed`ded into the
// runtime (compiler_wire.c). On the first `eval`, the runtime splices that image
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

let cachedSource: string | undefined;
let cachedDirect: boolean | undefined;
let cachedCallerStrict: boolean | undefined;
let cachedInParamExpr: boolean | undefined;
let cachedInFieldInitializer: boolean | undefined;
let cachedDirectEvalContext: string | undefined;
let cachedBuffer: Uint8Array | undefined;

globalThis.__compile = function __compile(
	source: string,
	direct?: boolean,
	callerStrict?: boolean,
	inParamExpr?: boolean,
	inFieldInitializer?: boolean,
	directEvalContext?: string,
): Uint8Array {
	try {
		// Runtime eval frequently recompiles the same literal source at one call
		// site. The wire buffer is immutable after it crosses the native boundary,
		// so a one-entry exact-context cache avoids rerunning the self-hosted compiler
		// without sharing any function object, environment, or execution state.
		if (
			cachedBuffer !== undefined &&
			cachedSource === source &&
			cachedDirect === direct &&
			cachedCallerStrict === callerStrict &&
			cachedInParamExpr === inParamExpr &&
			cachedInFieldInitializer === inFieldInitializer &&
			cachedDirectEvalContext === directEvalContext
		) {
			return cachedBuffer;
		}
		// completionValue: eval evaluates to its last expression's value.
		// direct: free identifiers resolve against the caller scope (a with-scope
		// the direct-eval intrinsic pushes) before the global.
		// callerStrict: direct eval inherits the caller's strictness (a "use strict"
		// prologue still promotes); indirect passes false (sloppy unless directive).
		// inParamExpr: retained as a positional ABI slot; parameter-environment
		// conflicts are encoded in directEvalContext.
		const buffer = compileSourceToBuffer(source, {
			completionValue: true,
			direct,
			callerStrict,
			inParamExpr,
			inFieldInitializer,
			directEvalContext,
		});
		cachedSource = source;
		cachedDirect = direct;
		cachedCallerStrict = callerStrict;
		cachedInParamExpr = inParamExpr;
		cachedInFieldInitializer = inFieldInitializer;
		cachedDirectEvalContext = directEvalContext;
		cachedBuffer = buffer;
		return buffer;
	} catch (e) {
		// A parse / early error compiling eval source is a SyntaxError in the
		// caller's realm (per spec, eval rejects malformed source with SyntaxError).
		// Re-throw as one so `e instanceof SyntaxError` holds; the original message
		// is preserved.
		const err = e as { message?: string } | undefined;
		throw new SyntaxError(err && err.message ? err.message : String(e));
	}
};
