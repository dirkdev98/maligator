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

// Whether this build includes the WHATWG URL surface (the ada-url C++ parser).
// Default on; the build config sets `-DMAL_WEB_PLATFORM=0` (see build-flags.ts)
// when `surface.webPlatform` is false, which compiles url.c away so no `mal_url_*`
// ada FFI symbols are referenced. Must be kept in lockstep with the Rust crate's
// `web-platform` Cargo feature (rust-build.ts) — with it off the ada archive + the
// `-lc++` link are dropped, so a stray URL reference would fail to link. URL is
// installed only by the host entry (host_main.c), gated on this too.
#ifndef MAL_WEB_PLATFORM
#define MAL_WEB_PLATFORM 1
#endif

// Per-ECMA-402-service gates for engine.intl.features. Each defaults to MAL_INTL
// (so `MAL_INTL=0` forces every service off, and a full Intl build has them all
// on). A subset build passes `-DMAL_INTL_HAS_<SERVICE>=0` for each UNSELECTED
// service (build-flags.ts), in lockstep with the Rust `intl-<service>` Cargo
// features — an off service's icu sub-crate + baked data are not compiled.
// Intl.Locale / getCanonicalLocales are the floor (gated by MAL_INTL, not
// per-service). Named MAL_INTL_HAS_* to avoid colliding with the MalIntlKind enum
// values (MAL_INTL_COLLATOR, …) in intl_object.h.
#ifndef MAL_INTL_HAS_COLLATOR
#define MAL_INTL_HAS_COLLATOR MAL_INTL
#endif
#ifndef MAL_INTL_HAS_NUMBER_FORMAT
#define MAL_INTL_HAS_NUMBER_FORMAT MAL_INTL
#endif
#ifndef MAL_INTL_HAS_DATE_TIME_FORMAT
#define MAL_INTL_HAS_DATE_TIME_FORMAT MAL_INTL
#endif
#ifndef MAL_INTL_HAS_PLURAL_RULES
#define MAL_INTL_HAS_PLURAL_RULES MAL_INTL
#endif
#ifndef MAL_INTL_HAS_LIST_FORMAT
#define MAL_INTL_HAS_LIST_FORMAT MAL_INTL
#endif
#ifndef MAL_INTL_HAS_SEGMENTER
#define MAL_INTL_HAS_SEGMENTER MAL_INTL
#endif
#ifndef MAL_INTL_HAS_DISPLAY_NAMES
#define MAL_INTL_HAS_DISPLAY_NAMES MAL_INTL
#endif
#ifndef MAL_INTL_HAS_RELATIVE_TIME_FORMAT
#define MAL_INTL_HAS_RELATIVE_TIME_FORMAT MAL_INTL
#endif
#ifndef MAL_INTL_HAS_DURATION_FORMAT
#define MAL_INTL_HAS_DURATION_FORMAT MAL_INTL
#endif