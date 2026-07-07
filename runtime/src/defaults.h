#pragma once

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
// 128-bit integers back the current (non-arbitrary-precision) BigInt. They
// cover the full i64/u64 ranges that BigInt64Array/BigUint64Array need.
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

// Whether this build includes runtime `eval` / `new Function` and the 1.6 MB
// baked compiler they need. Default on; the build config sets `-DMAL_EVAL=0`
// (see build-flags.ts) when `engine.eval` is false, which drops the `#embed` of
// compiler.malw (compiler_wire.c) and makes the eval/Function path throw an
// EvalError instead of compiling (builtin_eval.c). All dynamic-code entry points
// funnel through that one gate, so this covers indirect eval and the
// AsyncFunction/GeneratorFunction families too.
#ifndef MAL_EVAL
#define MAL_EVAL 1
#endif

// Whether this build includes the Intl (ECMA-402 / ICU4X) surface and its ~9 MB
// of baked CLDR data. Default on; the build config sets `-DMAL_INTL=0` (see
// build-flags.ts) when `engine.intl` is disabled, which makes builtin_intl.c
// install no `Intl` global (so `typeof Intl === "undefined"`) and the
// locale-sensitive methods (localeCompare / toLocaleString) fall back to
// locale-insensitive behaviour. Must be kept in lockstep with the Rust crate's
// `intl` Cargo feature (rust-build.ts) — with it off the ICU FFI symbols are not
// linked, so a stray call would fail to link.
#ifndef MAL_INTL
#define MAL_INTL 1
#endif