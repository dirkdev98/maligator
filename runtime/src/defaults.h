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

// Whether this build includes the RegExp engine (regress). Core ECMAScript, so
// default on; the build config sets `-DMAL_REGEXP=0` (see build-flags.ts) when
// `engine.regexp` is false, which compiles builtin_regexp.c / regexp_object.c away
// (RegExp is not installed → `typeof RegExp === "undefined"`), makes the String
// regex methods (match / matchAll / search, which coerce their arg to a RegExp)
// throw, and guards the GC finalizer's `mal_regexp_free`. Must be kept in lockstep
// with the Rust crate's `regexp` Cargo feature (rust-build.ts) — with it off the
// regress FFI symbols are not linked, so a stray call would fail to link. Pure
// string ops (split / replace / includes with a string arg) are unaffected.
#ifndef MAL_REGEXP
#define MAL_REGEXP 1
#endif

// Whether this build includes the node host built-in surface (`node:path`,
// `node:fs`, `node:child_process`, `node:crypto`). Unlike the features above this
// is OPT-IN: default OFF, the build config sets `-DMAL_NODE=1` (see build-flags.ts)
// when `surface.node` is true. Off by default because it is a host-capability
// surface (filesystem, process spawning) most builds should not expose. The host
// exports themselves are not implemented yet — this define exists so the C archive
// fingerprint (buildConfigCacheSuffix) and the eventual host installs agree on the
// axis. Not tied to any Rust Cargo feature (node adds no Rust deps).
#ifndef MAL_NODE
#define MAL_NODE 0
#endif

// GC build-dimension gates. These MUST live here (the shared low-level header
// every TU includes first) rather than in gc.h: heap.h gates the header's `dirty`
// remembered-set byte on `#if MAL_GC_GENERATIONAL` but includes only defaults.h,
// so a fallback in gc.h would leave heap.h and gc.h disagreeing on the default in
// any TU that reaches heap.h before gc.h (harmless while the default was 0 —
// undefined evaluates to 0 — but a struct-layout mismatch once it is 1).
//
// MAL_GC_GENERATIONAL: the non-moving sticky-mark-bit generational collector.
// Default ON (2026-07-10 flip — the measured per-store card tax is ~1.3% median on
// store-heavy micros); the build config sets `-DMAL_GC_GENERATIONAL=0`
// (build-flags.ts) to opt out for minimal/bare-metal profiles, folding the card
// barrier + the `dirty` byte out entirely.
#ifndef MAL_GC_GENERATIONAL
#define MAL_GC_GENERATIONAL 1
#endif
// MAL_GC_CONCURRENT: the SATB deletion-barrier half. Default off; the barrier
// folds out unless `-DMAL_GC_CONCURRENT=1`.
#ifndef MAL_GC_CONCURRENT
#define MAL_GC_CONCURRENT 0
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
