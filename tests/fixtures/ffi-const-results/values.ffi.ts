import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["values.h"],
	find: [{ includeDirs: ["."], sources: ["values.c"] }],
	types: { ImmutableToken: { handle: { destroy: "immutable_token_destroy" } } },
	globals: { immutable_fixed: { get: "getFixed" } },
	functions: {
		immutable_token_make: { async: "makeTokenAsync" },
		immutable_token_borrow: { returns: { borrowed: true }, async: "borrowTokenAsync" },
		immutable_token_consume: { async: "consumeTokenAsync" },
		immutable_token_destroy: { async: "destroyTokenAsync" },
		immutable_token_array: { params: { values: { array: { length: "count" } } } },
		immutable_token_with_callback: {
			async: "consumeTokenWithCallbackAsync",
			params: { callback: { callback: { data: "data" } } },
		},
		immutable_token_visit: {
			async: "visitTokenAsync",
			params: { callback: { callback: { data: "data" } } },
		},
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
