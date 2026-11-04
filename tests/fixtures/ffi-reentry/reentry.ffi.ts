import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["reentry.h"],
	find: [{ includeDirs: ["."], sources: ["reentry.c"] }],
	types: { ReentryResource: { handle: { destroy: "reentry_destroy", collect: true } } },
	functions: {
		reentry_text: { callsJavaScript: false },
		reentry_mutate: { callsJavaScript: false, params: { text: { string: true } } },
		reentry_after: { callsJavaScript: false },
		reentry_listen: {
			params: { callback: { callback: { replaced: true }, nullable: true } },
		},
		reentry_owned_text: {
			callsJavaScript: false,
			returns: { string: true, free: "reentry_release" },
		},
		reentry_open: { callsJavaScript: false },
		reentry_bad_result: {
			callsJavaScript: false,
			params: {
				resource: { out: true },
				text: { out: true, string: { length: "length" } },
			},
		},
		reentry_variadic: {
			callsJavaScript: false,
			variants: { reentry_i32: { args: ["int"] } },
		},
		reentry_callable: {
			callsJavaScript: false,
			returns: { callable: { lifetime: "library" } },
		},
	},
} satisfies MaligatorLibraryContract;
