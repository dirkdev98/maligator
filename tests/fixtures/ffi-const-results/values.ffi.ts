import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["values.h"],
	find: [{ includeDirs: ["."], sources: ["values.c"] }],
	globals: { immutable_fixed: { get: "getFixed" } },
	functions: {
		a_make: { async: "makeAsync" },
		z_make_before: { async: "makeBeforeAsync" },
		immutable_out: { params: { value: { out: true } } },
		immutable_inout: { params: { value: { inout: true } } },
		immutable_array: { params: { values: { array: { length: "count" } } } },
		immutable_callback_result: { params: { callback: { callback: {} } } },
		immutable_visit: {
			async: "visitAsync",
			params: { callback: { callback: { data: "data" } } },
		},
		immutable_notify: {
			async: "notifyAsync",
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
		},
	},
} satisfies MaligatorLibraryContract;
