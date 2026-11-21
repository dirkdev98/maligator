#pragma once

// Product builds lock the ECMAScript primordial graph. Compatibility and
// conformance builds opt out explicitly through the generated feature defines.
#ifndef MAL_PRIMORDIALS_LOCKED
#define MAL_PRIMORDIALS_LOCKED 1
#endif

#include <stddef.h>
#include <stdint.h>

// Default types
typedef uint8_t u8;
typedef int8_t i8;
typedef uint16_t c16;
typedef uint16_t u16;
typedef int16_t i16;
typedef int32_t b32;
typedef int32_t i32;
typedef uint32_t u32;
typedef int64_t i64;
typedef uint64_t u64;
// Native 128-bit arithmetic supports checked BigInt fast paths and scalar ABI conversions.
typedef __int128 i128;
typedef unsigned __int128 u128;
typedef float f32;
typedef double f64;
typedef uintptr_t uptr;
typedef char byte;
typedef ptrdiff_t size;
typedef size_t usize;

#define sizeof(x)   ((size)sizeof(x))
#define alignof(x)  ((size) _Alignof(x))
#define countof(a)  (sizeof(a) / sizeof(*(a)))
#define lengthof(s) (countof(s) - 1)

// Storage for state owned by the isolate pinned to the current mutator thread. Each
// VM runs on exactly one native thread for its lifetime, so per-thread storage is
// per-isolate storage. Helper threads see their own unused copies and must reach an
// isolate's state through an explicit pointer (e.g. MalGcState). Wasm has one isolate.
#if defined(__wasi__)
#define MAL_ISOLATE_LOCAL
#else
#define MAL_ISOLATE_LOCAL _Thread_local
#endif

// Whether this build includes runtime `eval` / `new Function` and the embedded
// baked compiler they need. Default on; the build config sets `-DMAL_EVAL=0`
// (see build-flags.ts) when `engine.eval` is false, which drops the `#embed` of
// compiler.malw (compiler_wire.c) and makes the eval/Function path throw an
// EvalError instead of compiling (builtin_eval.c). All dynamic-code entry points
// funnel through that one gate, so this covers indirect eval and the
// AsyncFunction/GeneratorFunction families too.
#ifndef MAL_EVAL
#define MAL_EVAL 1
#endif

// Whether this build includes the Realm surface (the `Realm` global / callable
// boundary). Default on; the build config sets `-DMAL_REALMS=0` (see
// build-flags.ts) when `engine.realms` is false. Kept in lockstep with the
// build-config `engine.realms` knob so the C archive fingerprint
// (buildConfigCacheSuffix) and the realm installs agree on the axis.
#ifndef MAL_REALMS
#define MAL_REALMS 1
#endif

// Whether this build includes the RegExp engine (regress). Core ECMAScript, so
// default on; the build config sets `-DMAL_REGEXP=0` (see build-flags.ts) when
// `engine.regexp` is false, which compiles builtin_regexp.c / regexp_object.c away
// (RegExp is not installed → `typeof RegExp === "undefined"`), makes the String
// regex methods (match / matchAll / search, which coerce their arg to a RegExp)
// throw, and guards the GC finalizer's `mal_regexp_release`. Must be kept in lockstep
// with the Rust crate's `regexp` Cargo feature (rust-build.ts) — with it off the
// regress FFI symbols are not linked, so a stray call would fail to link. Pure
// string ops (split / replace / includes with a string arg) are unaffected.
#ifndef MAL_REGEXP
#define MAL_REGEXP 1
#endif

/* Production-faithful source profiler. Profile builds opt in explicitly so
 * ordinary binaries retain identical generated/runtime code and cache identity. */
#ifndef MAL_PROFILE
#define MAL_PROFILE 0
#endif

