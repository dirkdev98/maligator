#pragma once

#include "./defaults.h"
#include "array_object.h"
#include "function_object.h"
#include "object_ops.h"

typedef struct MalVm MalVm;

#define MAL_ASCII_ATOM_CACHE_CAPACITY 256
static_assert(
    (MAL_ASCII_ATOM_CACHE_CAPACITY & (MAL_ASCII_ATOM_CACHE_CAPACITY - 1)) == 0,
    "ASCII atom cache capacity must be a power of two");

typedef struct MalAsciiAtomCacheEntry {
    u32 hash;
    MalString *atom;
} MalAsciiAtomCacheEntry;

/** Request-hot internal ASCII names cached per VM by mal_intrinsic_ascii. */
typedef enum MalHotIntrinsicKey {
    MAL_HOT_KEY_EMPTY,
    MAL_HOT_KEY_LENGTH,
    MAL_HOT_KEY_NAME,
    MAL_HOT_KEY_LAST_INDEX,
    MAL_HOT_KEY_EVENTS,
    MAL_HOT_KEY_EVENTS_COUNT,
    MAL_HOT_KEY_PROTOTYPE,
    MAL_HOT_KEY_GROUPS,
    MAL_HOT_KEY_INDEX,
    MAL_HOT_KEY_INPUT,
    MAL_HOT_KEY_VALUE,
    MAL_HOT_KEY_DONE,
    MAL_HOT_KEY_CONSTRUCTOR,
    MAL_HOT_KEY_THEN,
    MAL_HOT_KEY_NEXT,
    MAL_HOT_KEY_CALLEE,
    MAL_HOT_KEY_EXEC,
    MAL_HOT_KEY_READABLE_STATE,
    MAL_HOT_KEY_DESTROYED,
    MAL_HOT_KEY_ENDED,
    MAL_HOT_KEY_EMIT,
    MAL_HOT_KEY_PENDING,
    MAL_HOT_KEY_DATA,
    MAL_HOT_KEY_READABLE_QUEUE,
    MAL_HOT_KEY_READABLE_INDEX,
    MAL_HOT_KEY_ENCODING,
    MAL_HOT_KEY_FLOWING,
    MAL_HOT_KEY_NEW_LISTENER,
    MAL_HOT_KEY_REMOVE_LISTENER,
    MAL_HOT_KEY_READABLE_ENDED,
    MAL_HOT_KEY_PAUSED,
    MAL_HOT_KEY_READABLE,
    MAL_HOT_KEY_FLAGS,
    MAL_HOT_KEY_UNICODE_SETS,
    MAL_HOT_KEY_MULTILINE,
    MAL_HOT_KEY_IGNORE_CASE,
    MAL_HOT_KEY_HAS_INDICES,
    MAL_HOT_KEY_STICKY,
    MAL_HOT_KEY_DOT_ALL,
    MAL_HOT_KEY_GLOBAL,
    MAL_HOT_KEY_UNICODE,
    MAL_HOT_KEY_PUSH,
    MAL_HOT_KEY_ERROR,
    MAL_HOT_KEY_TO_JSON,
    MAL_HOT_KEY_SEARCH,
    MAL_HOT_KEY_TRUE,
    MAL_HOT_KEY_FALSE,
    MAL_HOT_KEY_PROXY_GET,
    MAL_HOT_KEY_PROXY_SET,
    MAL_HOT_KEY_PROXY_HAS,
    MAL_HOT_KEY_PROXY_DELETE_PROPERTY,
    MAL_HOT_KEY_PROXY_GET_OWN_PROPERTY_DESCRIPTOR,
    MAL_HOT_KEY_PROXY_DEFINE_PROPERTY,
    MAL_HOT_KEY_PROXY_OWN_KEYS,
    MAL_HOT_KEY_PROXY_GET_PROTOTYPE_OF,
    MAL_HOT_KEY_PROXY_SET_PROTOTYPE_OF,
    MAL_HOT_KEY_PROXY_IS_EXTENSIBLE,
    MAL_HOT_KEY_PROXY_PREVENT_EXTENSIONS,
    MAL_HOT_KEY_PROXY_APPLY,
    MAL_HOT_KEY_PROXY_CONSTRUCT,
    MAL_HOT_KEY_COUNT,
} MalHotIntrinsicKey;

/**
 * Well-known values created during VM bootstrap that the VM and compiler can
 * reference directly, without going through the global object.
 */
typedef enum MalIntrinsic {
    MAL_INTRINSIC_OBJECT_CONSTRUCTOR,
    MAL_INTRINSIC_OBJECT_PROTOTYPE,
    MAL_INTRINSIC_OBJECT_DEFINE_PROPERTY,
    MAL_INTRINSIC_ARRAY_CONSTRUCTOR,
    MAL_INTRINSIC_ARRAY_PROTOTYPE,
    MAL_INTRINSIC_ARRAY_PROTOTYPE_MAP,
    MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH,
    MAL_INTRINSIC_FUNCTION_CONSTRUCTOR,
    MAL_INTRINSIC_FUNCTION_PROTOTYPE,
    MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL,
    MAL_INTRINSIC_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_ERROR_PROTOTYPE,
    MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
    MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_URI_ERROR_PROTOTYPE,
    MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
    MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_AGGREGATE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_SUPPRESSED_ERROR_PROTOTYPE,
    MAL_INTRINSIC_STRING_CONSTRUCTOR,
    MAL_INTRINSIC_STRING_PROTOTYPE,
    MAL_INTRINSIC_NUMBER_CONSTRUCTOR,
    MAL_INTRINSIC_NUMBER_PROTOTYPE,
    MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR,
    MAL_INTRINSIC_BOOLEAN_PROTOTYPE,
    MAL_INTRINSIC_SYMBOL_CONSTRUCTOR,
    MAL_INTRINSIC_SYMBOL_PROTOTYPE,
    MAL_INTRINSIC_BIGINT_CONSTRUCTOR,
    MAL_INTRINSIC_BIGINT_PROTOTYPE,
    // Well-known symbol values (Table 1 of the spec), referenced by both the
    // VM and builtin install passes.
    MAL_INTRINSIC_SYMBOL_ITERATOR,
    MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR,
    MAL_INTRINSIC_SYMBOL_TO_STRING_TAG,
    MAL_INTRINSIC_SYMBOL_HAS_INSTANCE,
    MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE,
    MAL_INTRINSIC_SYMBOL_SPECIES,
    MAL_INTRINSIC_SYMBOL_IS_CONCAT_SPREADABLE,
    MAL_INTRINSIC_SYMBOL_MATCH,
    MAL_INTRINSIC_SYMBOL_MATCH_ALL,
    MAL_INTRINSIC_SYMBOL_REPLACE,
    MAL_INTRINSIC_SYMBOL_SEARCH,
    MAL_INTRINSIC_SYMBOL_SPLIT,
    MAL_INTRINSIC_SYMBOL_UNSCOPABLES,
    MAL_INTRINSIC_SYMBOL_DISPOSE,
    MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE,
    MAL_INTRINSIC_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_MAP_PROTOTYPE,
    MAL_INTRINSIC_MAP_PROTOTYPE_GET,
    MAL_INTRINSIC_MAP_PROTOTYPE_SET,
    MAL_INTRINSIC_MAP_PROTOTYPE_HAS,
    MAL_INTRINSIC_MAP_PROTOTYPE_DELETE,
    MAL_INTRINSIC_SET_CONSTRUCTOR,
    MAL_INTRINSIC_SET_PROTOTYPE,
    MAL_INTRINSIC_SET_PROTOTYPE_ADD,
    MAL_INTRINSIC_SET_PROTOTYPE_HAS,
    MAL_INTRINSIC_SET_PROTOTYPE_DELETE,
    MAL_INTRINSIC_SET_PROTOTYPE_VALUES,
    MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_MAP_PROTOTYPE,
    MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_SET_PROTOTYPE,
    MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_REF_PROTOTYPE,
    MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR,
    MAL_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE,
    MAL_INTRINSIC_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_GENERATOR_PROTOTYPE,
    // %GeneratorFunction.prototype% (%Generator%): the [[Prototype]] of
    // generator function objects; its own .prototype is %GeneratorPrototype%.
    MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE,
    MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR,
    // Async iteration: %AsyncIteratorPrototype% → %AsyncGeneratorPrototype% →
    // %AsyncGenerator% (=AsyncGeneratorFunction.prototype) → %AsyncGeneratorFunction%.
    MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE,
    MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE,
    MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR,
    // %AsyncFunction% + %AsyncFunction.prototype%: the [[Prototype]] of async
    // (non-generator) function objects.
    MAL_INTRINSIC_ASYNC_FUNCTION_CONSTRUCTOR,
    MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE,
    // %Iterator% global + the Iterator Helpers live on %IteratorPrototype%.
    MAL_INTRINSIC_ITERATOR_CONSTRUCTOR,
    MAL_INTRINSIC_ITERATOR_HELPER_PROTOTYPE,
    // %AsyncIterator% global (abstract); its prototype is %AsyncIteratorPrototype%.
    MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR,
    MAL_INTRINSIC_PARSE_INT,
    MAL_INTRINSIC_PARSE_FLOAT,
    MAL_INTRINSIC_IS_NAN,
    MAL_INTRINSIC_IS_FINITE,
    MAL_INTRINSIC_MATH,
    MAL_INTRINSIC_JSON,
    MAL_INTRINSIC_ATOMICS,
    MAL_INTRINSIC_REFLECT,
    MAL_INTRINSIC_CONSOLE,
    MAL_INTRINSIC_GLOBAL_THIS,
    MAL_INTRINSIC_NAN_VALUE,
    MAL_INTRINSIC_INFINITY_VALUE,
    MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
    MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE,
    MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR,
    MAL_INTRINSIC_DATA_VIEW_PROTOTYPE,
    // %TypedArray% and %TypedArray%.prototype: the abstract super-constructor and
    // shared prototype that the per-kind ones inherit from.
    MAL_INTRINSIC_TYPED_ARRAY_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_PROTOTYPE,
    // Per-kind constructors, kept contiguous in MalTypedArrayKind order so they
    // can be indexed as (MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + kind).
    MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE,
    MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR = MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR,
    // Per-kind prototypes, contiguous in the same order.
    MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE,
    MAL_INTRINSIC_TYPED_ARRAY_INT8_PROTOTYPE = MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_INT16_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_UINT16_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_INT32_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_UINT32_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_PROTOTYPE,
    MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_PROTOTYPE,
    MAL_INTRINSIC_PROMISE_CONSTRUCTOR,
    MAL_INTRINSIC_PROMISE_PROTOTYPE,
    // The %Proxy% constructor. Proxy has no .prototype (it is an exotic, not a
    // class), and its instances are MalProxyObject exotics.
    MAL_INTRINSIC_PROXY_CONSTRUCTOR,
    MAL_INTRINSIC_DATE_CONSTRUCTOR,
    MAL_INTRINSIC_DATE_PROTOTYPE,
#if MAL_TEMPORAL
    MAL_INTRINSIC_TEMPORAL,
    MAL_INTRINSIC_TEMPORAL_DURATION_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_DURATION_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE,
    MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR,
    MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE,
#endif
    MAL_INTRINSIC_REGEXP_CONSTRUCTOR,
    MAL_INTRINSIC_REGEXP_PROTOTYPE,
    // %RegExpStringIteratorPrototype%: the prototype of the iterator returned by
    // RegExp.prototype[@@matchAll] / String.prototype.matchAll.
    MAL_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE,
    // The Intl namespace object + each service's constructor/prototype pair.
    MAL_INTRINSIC_INTL,
    MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE,
    MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE,
    MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE,
    MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE,
    MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE,
    MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE,
    MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_DISPLAY_NAMES_PROTOTYPE,
    MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE,
    MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_SEGMENTER_PROTOTYPE,
    MAL_INTRINSIC_INTL_SEGMENTS_PROTOTYPE,
    MAL_INTRINSIC_INTL_SEGMENT_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR,
    MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE,
    // The four global URI handling functions (sec-uri-handling-functions).
    MAL_INTRINSIC_DECODE_URI,
    MAL_INTRINSIC_DECODE_URI_COMPONENT,
    MAL_INTRINSIC_ENCODE_URI,
    MAL_INTRINSIC_ENCODE_URI_COMPONENT,
    /**
     * The CommonJS `require` native handed to module wrappers. Called with a
     * numeric module id (the compiler resolves `require("lit")` to its id) and
     * runs/caches that module via mal_vm_cjs_require; a non-numeric argument is a
     * "dynamic require is not supported" TypeError. Not exposed on globalThis.
     */
    MAL_INTRINSIC_CJS_REQUIRE,
    /**
     * %ThrowTypeError%: the unique, frozen, anonymous function that throws a
     * TypeError on call. Backs the poisoned `caller`/`arguments` accessors on
     * %Function.prototype% (and strict mapped-arguments `callee`).
     */
    MAL_INTRINSIC_THROW_TYPE_ERROR,
    /**
     * Internal helper backing the compiler's guarded array-iteration inlining. Not
     * exposed as a global. `__arrayIterationEligible(callee, arr, methodId)`
     * returns true iff the already-loaded method is the original builtin and the
     * receiver admits the compiler's inlined loop. Loaded via LOAD_INTRINSIC.
     */
    MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE,
    /*
     * Hidden flatMap append helper for the compiler's guarded inlining:
     * __arrayFlatMapAppend(result, mapped) flattens `mapped` one level into the
     * result array being built. Loaded via LOAD_INTRINSIC.
     */
    MAL_INTRINSIC_ARRAY_FLAT_MAP_APPEND,
    /*
     * The global `eval` function (builtin_eval.c). Resolved by LOAD_INTRINSIC for
     * the bare `eval` identifier and exposed as a global property; on first call
     * it splices the baked self-hosted compiler into the running VM.
     */
    MAL_INTRINSIC_EVAL,
    /*
     * The direct-eval intrinsic (builtin_eval.c). Not exposed on globalThis;
     * the compiler emits it as the callee of a direct `eval(...)` call, passing
     * the source and a scope object marshaled from the caller's visible bindings.
     */
    MAL_INTRINSIC_DIRECT_EVAL,
    /*
     * HostImportModuleDynamically entry point emitted for `import(specifier)`.
     * Not exposed on globalThis.
     */
    MAL_INTRINSIC_DYNAMIC_IMPORT,
    /*
     * WinterTC fetch server slots (runtime/web_fetch.c). Installed only by the host
     * entry (mal_fetch_install), so they stay undefined — and harmless — in the bare
     * test262 VM. Stored here so the collector roots them (scan_roots marks every
     * intrinsic), including the live fetch handler.
     */
    MAL_INTRINSIC_RESPONSE_CONSTRUCTOR,
    MAL_INTRINSIC_RESPONSE_PROTOTYPE,
    MAL_INTRINSIC_REQUEST_PROTOTYPE,
    MAL_INTRINSIC_HEADERS_CONSTRUCTOR,
    MAL_INTRINSIC_HEADERS_PROTOTYPE,
    MAL_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_BLOB_CONSTRUCTOR,
    MAL_INTRINSIC_BLOB_PROTOTYPE,
    MAL_INTRINSIC_FORM_DATA_CONSTRUCTOR,
    MAL_INTRINSIC_FORM_DATA_PROTOTYPE,
    MAL_INTRINSIC_FORM_DATA_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_FETCH_HANDLER,
    /*
     * WHATWG URL / URLSearchParams (runtime/web_url.c). Host-entry only
     * (mal_url_install), so they stay undefined in the bare test262 VM. Rooted by
     * scan_roots like every intrinsic slot.
     */
    MAL_INTRINSIC_URL_CONSTRUCTOR,
    MAL_INTRINSIC_URL_PROTOTYPE,
    MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR,
    MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE,
    MAL_INTRINSIC_URL_SEARCH_PARAMS_ITERATOR_PROTOTYPE,
    /*
     * DOMException / Event / EventTarget / AbortSignal / AbortController
     * (runtime/web_events.c).
     * Host-entry only, so undefined in the bare test262 VM.
     */
    MAL_INTRINSIC_DOM_EXCEPTION_CONSTRUCTOR,
    MAL_INTRINSIC_DOM_EXCEPTION_PROTOTYPE,
    MAL_INTRINSIC_DOM_EXCEPTION_NAME_KEY,
    MAL_INTRINSIC_DOM_EXCEPTION_MESSAGE_KEY,
    MAL_INTRINSIC_EVENT_CONSTRUCTOR,
    MAL_INTRINSIC_EVENT_PROTOTYPE,
    MAL_INTRINSIC_EVENT_TRUSTED_KEY,
    MAL_INTRINSIC_EVENT_IS_TRUSTED_GETTER,
    MAL_INTRINSIC_CUSTOM_EVENT_CONSTRUCTOR,
    MAL_INTRINSIC_CUSTOM_EVENT_PROTOTYPE,
    MAL_INTRINSIC_EVENT_TARGET_CONSTRUCTOR,
    MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE,
    MAL_INTRINSIC_ABORT_SIGNAL_CONSTRUCTOR,
    MAL_INTRINSIC_ABORT_SIGNAL_PROTOTYPE,
    MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR,
    MAL_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE,
    /* WHATWG default readable streams (runtime/web_readable_stream.c), host-entry only. */
    MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_STREAM_PROTOTYPE,
    MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE,
    MAL_INTRINSIC_READABLE_BYTE_STREAM_CONTROLLER_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_BYTE_STREAM_CONTROLLER_PROTOTYPE,
    MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE,
    MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_PROTOTYPE,
    MAL_INTRINSIC_READABLE_STREAM_BYOB_REQUEST_CONSTRUCTOR,
    MAL_INTRINSIC_READABLE_STREAM_BYOB_REQUEST_PROTOTYPE,
    MAL_INTRINSIC_WRITABLE_STREAM_CONSTRUCTOR,
    MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE,
    MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_CONTROLLER_CONSTRUCTOR,
    MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE,
    MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_CONSTRUCTOR,
    MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_PROTOTYPE,
    MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_CONSTRUCTOR,
    MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_PROTOTYPE,
    MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_SIZE,
    MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_CONSTRUCTOR,
    MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_PROTOTYPE,
    MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_SIZE,
    /* Per-realm shared Node EventEmitter identity, populated lazily by its installer. */
    MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE,
    /* Per-realm Node Buffer identity and its CommonJS/default export object. */
    MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE,
    MAL_INTRINSIC_NODE_BUFFER_MODULE,
    /* Shared free-global and node:process module object. */
    MAL_INTRINSIC_NODE_PROCESS_MODULE,
    /* Per-realm callable node:assert and object-shaped strict assertion modules. */
    MAL_INTRINSIC_NODE_ASSERT_MODULE,
    /* Per-realm node:assert/strict CommonJS/default export object. */
    MAL_INTRINSIC_NODE_ASSERT_STRICT_MODULE,
    /* Per-realm Node stream constructor/prototype graph, populated lazily. */
    MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_STREAM_PROTOTYPE,
    MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_READABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_DUPLEX_PROTOTYPE,
    MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE,
    /* Per-realm Node filesystem/crypto modules with default + named identity. */
    MAL_INTRINSIC_NODE_FS_MODULE,
    MAL_INTRINSIC_NODE_FS_PROMISES_MODULE,
    MAL_INTRINSIC_NODE_V8_MODULE,
    MAL_INTRINSIC_NODE_VM_MODULE,
    MAL_INTRINSIC_NODE_DIAGNOSTICS_CHANNEL_MODULE,
    MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE,
    MAL_INTRINSIC_NODE_MODULE_API_MODULE,
    MAL_INTRINSIC_NODE_CRYPTO_MODULE,
    MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE,
    MAL_INTRINSIC_NODE_TLS_MODULE,
    /* Per-realm node:http initialization graph and CommonJS/default export. */
    MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE,
    MAL_INTRINSIC_NODE_HTTP_MODULE,
    /* Per-realm Node initialization companions used by Express. */
    MAL_INTRINSIC_NODE_URL_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_URL_PROTOTYPE,
    MAL_INTRINSIC_NODE_URL_MODULE,
    MAL_INTRINSIC_NODE_QUERYSTRING_MODULE,
    MAL_INTRINSIC_NODE_NET_SOCKET_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_NET_SOCKET_PROTOTYPE,
    MAL_INTRINSIC_NODE_NET_MODULE,
    MAL_INTRINSIC_NODE_OS_MODULE,
    /* Per-realm node:zlib CommonJS/default export object, populated lazily. */
    MAL_INTRINSIC_NODE_ZLIB_MODULE,
    MAL_INTRINSIC_NODE_SQLITE_MODULE,
    MAL_INTRINSIC_NODE_SQLITE_DATABASE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_SQLITE_DATABASE_PROTOTYPE,
    MAL_INTRINSIC_NODE_SQLITE_STATEMENT_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_SQLITE_STATEMENT_PROTOTYPE,
#if MAL_REALMS
    MAL_INTRINSIC_SHADOW_REALM_CONSTRUCTOR,
    MAL_INTRINSIC_SHADOW_REALM_PROTOTYPE,
#endif
    /* Per-realm Node Error stack customization state. */
    MAL_INTRINSIC_ERROR_PREPARE_STACK_TRACE_VALUE,
    MAL_INTRINSIC_ERROR_STACK_TRACE_LIMIT_VALUE,
    MAL_INTRINSIC_COUNT,
} MalIntrinsic;

/**
 * Create all intrinsic objects and install the builtins on them.
 */
void mal_intrinsics_init(MalVm *vm);

/**
 * Allocate a string from a NUL-terminated ASCII name.
 */
MalString *mal_intrinsic_ascii(MalVm *vm, const byte *name);

/**
 * Return the VM-lifetime canonical representative for an existing string.
 * Property-key conversion uses this after excluding array indices.
 */
MalString *mal_property_atomize_string(MalVm *vm, MalString *string);

/** Return a one-code-unit string, interning Latin-1 values in a VM-local cache. */
MalString *mal_intrinsic_code_unit(MalVm *vm, c16 code_unit);

/** Return a measured hot atom directly by its compile-time identifier. */
MalString *mal_intrinsic_hot_ascii(MalVm *vm, MalHotIntrinsicKey key);

/**
 * Build a string property key from a NUL-terminated ASCII name.
 */
MalKey mal_intrinsic_string_key(MalVm *vm, const byte *name);

/** Build a string property key directly from a measured hot-key identifier. */
MalKey mal_intrinsic_hot_string_key(MalVm *vm, MalHotIntrinsicKey key);

/**
 * Build a symbol property key from a well-known symbol intrinsic slot.
 */
MalKey mal_intrinsic_symbol_key(MalVm *vm, MalIntrinsic symbol_slot);

/**
 * Create a native function and define it as a writable + configurable method
 * under a well-known symbol key. display_name becomes the function name
 * (e.g. "[Symbol.iterator]").
 */
MalValue mal_intrinsic_define_symbol_method(
    MalVm *vm,
    MalObject *object,
    MalIntrinsic symbol_slot,
    const byte *display_name,
    MalNativeFunctionCallback callback
);

/**
 * Define the spec-shaped `get [Symbol.species]` accessor (returns the
 * receiver) on a constructor.
 */
void mal_intrinsic_define_species(MalVm *vm, MalObject *constructor);

/**
 * The default `@@species` getter (returns its `this`). Exposed so the compiler's
 * guarded map/filter inlining can confirm a constructor's `@@species` is unmodified
 * (callback-pointer compare) before assuming ArraySpeciesCreate yields a plain Array.
 */
MalValue mal_intrinsic_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);

/**
 * Build a data property descriptor with the given flags.
 */
MalPropertyDesc mal_intrinsic_data_desc(MalValue value, MalPropertyFlags flags);

/** Build an accessor descriptor, adding MAL_PROPERTY_ACCESSOR to `flags`. */
MalPropertyDesc mal_intrinsic_accessor_desc(
    MalValue getter, MalValue setter, MalPropertyFlags flags);

/**
 * Install an accessor whose getter/setter are native functions. A null callback
 * leaves that half undefined. Display names, arities, key kind, and flags are
 * supplied explicitly so this helper does not infer observable metadata.
 */
void mal_intrinsic_define_accessor_n(
    MalVm *vm,
    MalObject *object,
    MalKey key,
    const byte *getter_name,
    i32 getter_length,
    MalNativeFunctionCallback getter,
    const byte *setter_name,
    i32 setter_length,
    MalNativeFunctionCallback setter,
    MalPropertyFlags flags
);

/** Install a getter-only, string-keyed intrinsic accessor of arity zero. */
void mal_intrinsic_define_getter(
    MalVm *vm,
    MalObject *object,
    const byte *name,
    const byte *getter_name,
    MalNativeFunctionCallback getter,
    MalPropertyFlags flags
);

/**
 * Define a named data property on an intrinsic object.
 */
void mal_intrinsic_define_data(MalVm *vm, MalObject *object, const byte *name, MalValue value, MalPropertyFlags flags);

/**
 * Create a native function and define it as a writable + configurable method.
 *
 * Returns the function value so callers can additionally store it in an
 * intrinsic slot.
 */
MalValue mal_intrinsic_define_method(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback callback);

/**
 * mal_intrinsic_define_method with an explicit arity exposed as the method's
 * `length` own property (the spec count of required parameters). Prefer this
 * over mal_intrinsic_define_method so the function reports the spec length.
 */
MalValue mal_intrinsic_define_method_n(MalVm *vm, MalObject *object, const byte *name, i32 length, MalNativeFunctionCallback callback);

/**
 * Allocate an ordinary object backed by %Object.prototype%.
 */
MalObject *mal_intrinsic_new_object(MalVm *vm);

/**
 * Allocate an array backed by %Array.prototype% with the given length.
 */
MalArrayObject *mal_intrinsic_new_array(MalVm *vm, u32 length);
MalArrayObject *mal_intrinsic_new_dense_array(MalVm *vm, u32 length);

/**
 * Allocate an error backed by the given error prototype slot with the message
 * set as an own property, and set it as the VM's throw completion.
 */
void mal_vm_throw_error(MalVm *vm, MalIntrinsic prototype_slot, const byte *message);

/**
 * mal_vm_throw_error with an arbitrary value as the message.
 */
void mal_vm_throw_error_value(MalVm *vm, MalIntrinsic prototype_slot, MalValue message);

/** Set the pending completion to the preallocated, non-allocating OOM exception. */
void mal_vm_throw_allocation_error(MalVm *vm);

/** Preallocate the singleton OOM exception without capturing a stack trace. */
MalValue mal_vm_create_allocation_error(MalVm *vm);
