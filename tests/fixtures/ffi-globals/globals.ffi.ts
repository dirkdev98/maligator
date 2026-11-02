import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["globals.h"],
	find: [{ includeDirs: ["."], sources: ["globals.c"] }],
	types: { GlobalsContext: { handle: { destroy: "globals_destroy" } } },
	globals: {
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
		globals_title: { get: "getTitle", returns: { string: true } },
		globals_context: { get: "getContext", returns: { borrowed: true } },
		globals_transform: {
			get: "getTransform",
			returns: { callable: { lifetime: "library" } },
		},
		globals_unprovided: { get: "getUnprovided" },
		globals_values: { get: "getValues", set: "setValues" },
		globals_matrix: { get: "getMatrix", set: "setMatrix" },
		globals_points: { get: "getPoints", set: "setPoints" },
		globals_fixed_values: { get: "getFixedValues" },
		globals_signals: { get: "getSignals", set: "setSignals" },
		globals_threads: { get: "getThreads", set: "setThreads" },
	},
} satisfies MaligatorLibraryContract;
