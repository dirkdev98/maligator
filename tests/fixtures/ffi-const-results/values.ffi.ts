import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["values.h"],
	find: [{ includeDirs: ["."], sources: ["values.c"] }],
	types: {
		ImmutableToken: { handle: { destroy: "immutable_token_destroy" } },
		ImmutableChoice: { shape: { member: "integer" } },
	},
	globals: { immutable_fixed: { get: "getFixed" } },
	functions: {
		immutable_choice_int: { async: "choiceIntAsync" },
		immutable_choice_take_int: { async: "takeChoiceIntAsync" },
		immutable_choice_record: {
			returns: { shape: { member: "record" } },
			async: "choiceRecordAsync",
		},
		immutable_choice_take_record: {
			params: { value: { shape: { member: "record" } } },
			async: "takeChoiceRecordAsync",
		},
		immutable_choice_array: {
			returns: { shape: { member: "samples" } },
			async: "choiceArrayAsync",
		},
		immutable_choice_take_array: {
			params: { value: { shape: { member: "samples" } } },
			async: "takeChoiceArrayAsync",
		},
		immutable_choice_out: {
			params: { value: { out: true, shape: { member: "record" } } },
			async: "choiceOutAsync",
		},
		immutable_choice_inout: {
			params: { value: { inout: true, shape: { member: "record" } } },
			async: "choiceInoutAsync",
		},
		immutable_choice_sum: {
			params: { values: { array: { length: "count" } } },
			async: "choiceSumAsync",
		},
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
		immutable_array_out: { params: { value: { out: true } }, async: "arrayOutAsync" },
		immutable_pair_out: { params: { value: { out: true } }, async: "pairOutAsync" },
		immutable_pair_inout: { params: { value: { inout: true } }, async: "pairInoutAsync" },
		immutable_numbers_out: { params: { value: { out: true } }, async: "numbersOutAsync" },
		immutable_grid_out: { params: { value: { out: true } }, async: "gridOutAsync" },
		immutable_grid_inout: { params: { value: { inout: true } }, async: "gridInoutAsync" },
		immutable_token_array_out: { params: { value: { out: true } } },
		immutable_pair_many: {
			params: { value: { inout: true, array: { length: "count" } } },
			async: "pairManyAsync",
		},
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
		immutable_callback_result: {
			params: { callback: { callback: {} } },
			async: "callbackResultAsync",
		},
		immutable_callback_check: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackCheckAsync",
		},
		immutable_callback_parallel: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: "wait" } },
			},
			async: "callbackParallelAsync",
		},
		immutable_callback_shutdown: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackShutdownAsync",
		},
		immutable_callback_cancel: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackCancelAsync",
		},
		immutable_callback_replace: {
			params: {
				callback: { nullable: true, callback: { replaced: true, queued: "wait" } },
			},
		},
		immutable_callback_replaced: { async: "callbackReplacedAsync" },
		immutable_choice_callback: {
			returns: { shape: { member: "record" } },
			params: { callback: { callback: { returns: { shape: { member: "record" } } } } },
			async: "choiceCallbackAsync",
		},
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
