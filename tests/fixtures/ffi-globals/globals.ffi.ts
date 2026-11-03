import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["globals.h"],
	find: [{ includeDirs: ["."], sources: ["globals.c"] }],
	types: { GlobalsContext: { handle: { destroy: "globals_destroy" } } },
	globals: {
		globals_retained_void: {
			get: "getRetainedVoid",
			set: "setRetainedVoid",
			value: {
				bytes: { length: "globals_retained_signed_count" },
				lifetime: "replacement",
			},
		},
		globals_retained_title: {
			get: "getRetainedTitle",
			set: "setRetainedTitle",
			value: { string: true, lifetime: "replacement" },
		},
		globals_retained_bytes: {
			get: "getRetainedBytes",
			set: "setRetainedBytes",
			value: { bytes: { length: "globals_retained_count" }, lifetime: "replacement" },
		},
		globals_retained_count: { get: "getRetainedCount" },
		globals_mode: {
			get: "getMode",
			set: "setMode",
			evidence: [{ kind: "global", name: "globals_mode" }],
		},
		globals_limit: { get: "getLimit" },
		globals_aliased_limit: { get: "getAliasedLimit" },
		globals_fixed_point: { get: "getFixedPoint" },
		globals_signal: { get: "getSignal", set: "setSignal" },
		globals_serial: { get: "getSerial", set: "setSerial" },
		globals_ratio: { get: "getRatio", set: "setRatio" },
		globals_thread: { get: "getThread", set: "setThread" },
		globals_point: { get: "getPoint", set: "setPoint" },
		globals_title: { get: "getTitle", value: { string: true } },
		globals_context: { get: "getContext", value: { borrowed: true } },
		globals_transform: {
			get: "getTransform",
			value: { callable: { lifetime: "library" } },
		},
		globals_unprovided: { get: "getUnprovided" },
		globals_values: { get: "getValues", set: "setValues" },
		globals_matrix: { get: "getMatrix", set: "setMatrix" },
		globals_points: { get: "getPoints", set: "setPoints" },
		globals_fixed_values: { get: "getFixedValues" },
		globals_signals: { get: "getSignals", set: "setSignals" },
		globals_threads: { get: "getThreads", set: "setThreads" },
		globals_label: { get: "getLabel", set: "setLabel", value: { string: true } },
		globals_bytes: { get: "getBytes", set: "setBytes", value: { bytes: true } },
		globals_signed_bytes: {
			get: "getSignedBytes",
			set: "setSignedBytes",
			value: { bytes: true },
		},
		globals_volatile_bytes: {
			get: "getVolatileBytes",
			set: "setVolatileBytes",
			value: { bytes: true },
		},
		globals_thread_label: {
			get: "getThreadLabel",
			set: "setThreadLabel",
			value: { string: true },
		},
		globals_fixed_label: { get: "getFixedLabel", value: { string: true } },
		globals_sink: { set: "setSink", value: { string: true } },
	},
} satisfies MaligatorLibraryContract;
