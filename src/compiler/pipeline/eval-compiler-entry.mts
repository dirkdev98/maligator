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

import { compilePreparedSourceToBuffer, prepareSourceForCompilation } from "./compile.ts";

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

interface EvalCompilerCacheEntry {
	source: string;
	direct: boolean | undefined;
	callerStrict: boolean | undefined;
	inParamExpr: boolean | undefined;
	inFieldInitializer: boolean | undefined;
	directEvalContext: string | undefined;
	buffer: Uint8Array;
	retainedBytes: number;
	semanticallyEmpty: boolean;
}

const CACHE_MAX_ENTRIES = 16;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const cache: Array<EvalCompilerCacheEntry> = [];
let cacheBytes = 0;

function cachedCompilation(
	source: string,
	direct: boolean | undefined,
	callerStrict: boolean | undefined,
	inParamExpr: boolean | undefined,
	inFieldInitializer: boolean | undefined,
	directEvalContext: string | undefined,
	semanticallyEmpty: boolean,
): Uint8Array | undefined {
	for (let index = 0; index < cache.length; index++) {
		const entry = cache[index]!;
		if (
			entry.semanticallyEmpty !== semanticallyEmpty ||
			(!semanticallyEmpty && entry.source !== source) ||
			entry.direct !== direct ||
			entry.callerStrict !== callerStrict ||
			entry.inParamExpr !== inParamExpr ||
			entry.inFieldInitializer !== inFieldInitializer ||
			entry.directEvalContext !== directEvalContext
		) {
			continue;
		}
		for (let move = index; move > 0; move--) cache[move] = cache[move - 1]!;
		cache[0] = entry;
		return entry.buffer;
	}
	return undefined;
}

function retainCompilation(
	source: string,
	direct: boolean | undefined,
	callerStrict: boolean | undefined,
	inParamExpr: boolean | undefined,
	inFieldInitializer: boolean | undefined,
	directEvalContext: string | undefined,
	buffer: Uint8Array,
	semanticallyEmpty: boolean,
) {
	// Count retained source/context strings as UTF-16 so a small wire image cannot
	// pin an arbitrarily large eval input outside the byte budget.
	const retainedBytes =
		(semanticallyEmpty ? 0 : source.length * 2) +
		(directEvalContext?.length ?? 0) * 2 +
		buffer.byteLength;
	if (retainedBytes > CACHE_MAX_BYTES) return;
	while (
		cache.length > 0 &&
		(cache.length >= CACHE_MAX_ENTRIES || cacheBytes + retainedBytes > CACHE_MAX_BYTES)
	) {
		cacheBytes -= cache[cache.length - 1]!.retainedBytes;
		cache.length--;
	}
	cacheBytes += retainedBytes;
	const entry = {
		source,
		direct,
		callerStrict,
		inParamExpr,
		inFieldInitializer,
		directEvalContext,
		buffer,
		retainedBytes,
		semanticallyEmpty,
	};
	cache.push(entry);
	for (let index = cache.length - 1; index > 0; index--) cache[index] = cache[index - 1]!;
	cache[0] = entry;
}

globalThis.__compile = function __compile(
	source: string,
	direct?: boolean,
	callerStrict?: boolean,
	inParamExpr?: boolean,
	inFieldInitializer?: boolean,
	directEvalContext?: string,
): Uint8Array {
	try {
		// Wire images are immutable compiler output; execution still creates fresh
		// functions, bindings, environments, and completion state after every hit.
		const cached = cachedCompilation(
			source,
			direct,
			callerStrict,
			inParamExpr,
			inFieldInitializer,
			directEvalContext,
			false,
		);
		if (cached !== undefined) return cached;
		// completionValue: eval evaluates to its last expression's value.
		// direct: free identifiers resolve against the caller scope (a with-scope
		// the direct-eval intrinsic pushes) before the global.
		// callerStrict: direct eval inherits the caller's strictness (a "use strict"
		// prologue still promotes); indirect passes false (sloppy unless directive).
		// inParamExpr: retained as a positional ABI slot; parameter-environment
		// conflicts are encoded in directEvalContext.
		const options = {
			completionValue: true,
			optimization: "development" as const,
			direct,
			callerStrict,
			inParamExpr,
			inFieldInitializer,
			directEvalContext,
		};
		const prepared = prepareSourceForCompilation(source, options);
		if (prepared.semanticallyEmpty) {
			const empty = cachedCompilation(
				"",
				direct,
				callerStrict,
				inParamExpr,
				inFieldInitializer,
				directEvalContext,
				true,
			);
			if (empty !== undefined) return empty;
		}
		const buffer = compilePreparedSourceToBuffer(prepared, options);
		retainCompilation(
			prepared.semanticallyEmpty ? "" : source,
			direct,
			callerStrict,
			inParamExpr,
			inFieldInitializer,
			directEvalContext,
			buffer,
			prepared.semanticallyEmpty,
		);
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
