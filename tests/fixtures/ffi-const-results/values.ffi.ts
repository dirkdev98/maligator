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
		immutable_token_array: {
			params: { values: { array: { length: "count" } } },
			async: "tokenArrayAsync",
		},
		immutable_token_with_callback: {
			async: "consumeTokenWithCallbackAsync",
			params: { callback: { callback: { data: "data" } } },
		},
		immutable_token_visit: {
			async: "visitTokenAsync",
			params: { callback: { callback: { data: "data" } } },
		},
		a_make: { async: "makeAsync" },
		a_take_before: { async: "takeBeforeAsync" },
		z_take: { async: "takeAsync" },
		immutable_bits_take: { async: "takeBitsAsync" },
		z_make_before: { async: "makeBeforeAsync" },
		immutable_out: { params: { value: { out: true } }, async: "outAsync" },
		immutable_inout: { params: { value: { inout: true } }, async: "inoutAsync" },
		immutable_array_out: { params: { value: { out: true } } },
		immutable_pair_out: { params: { value: { out: true } } },
		immutable_numbers_out: { params: { value: { out: true } } },
		immutable_token_out: { params: { value: { out: true } }, async: "tokenOutAsync" },
		immutable_token_out_visit: {
			params: { value: { out: true }, callback: { callback: { data: "data" } } },
			async: "tokenOutVisitAsync",
		},
		immutable_token_inout: { params: { value: { inout: true } } },
		immutable_array: {
			params: { values: { array: { length: "count" } } },
			async: "arrayAsync",
		},
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
