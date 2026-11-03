import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
const array = { array: { length: "length" }, free: "array_free" };
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["arrays.h"],
	find: [{ includeDirs: ["."], sources: ["arrays.c"] }],
	types: { ArrayResource: { handle: { destroy: "resource_free", collect: false } } },
	functions: {
		table_make: {
			returns: { array: { length: "length" } },
			params: {
				prior: { nullable: true },
				message: { out: true, string: { length: "message_length" } },
			},
			async: "tableMakeAsync",
		},
		table_wait: { returns: { array: { length: "length" } }, async: "tableWaitAsync" },
		array_fresh_fail: {
			returns: { borrowed: true, fresh: true },
			params: { out: { out: true, ...array } },
		},
		array_register: {
			params: {
				callback: {
					nullable: true,
					callback: { replaced: true, returns: { lifetime: "registration" } },
				},
			},
		},
		array_single: { returns: array, async: "singleAsync" },
		array_existing_bad: {
			returns: array,
			params: { message: { out: true, string: { length: "message_length" } } },
			async: "existingBadAsync",
		},
		resource_recycled: { returns: { fresh: true } },
		resource_on_destroy: {
			params: { callback: { nullable: true, callback: { replaced: true } } },
		},
		array_fresh: {
			returns: { borrowed: true, fresh: true },
			params: { out: { out: true, ...array } },
		},
		buffer_single: {
			returns: { string: true, free: "buffer_free_first" },
			async: "bufferSingleAsync",
		},
		array_make: {
			returns: array,
			params: { message: { out: true, string: { length: "message_length" } } },
			async: "makeAsync",
		},
		array_fail: {
			returns: array,
			params: { message: { out: true, string: { length: "message_length" } } },
			async: "failAsync",
		},
		array_alias: {
			returns: array,
			params: {
				other: { out: true, array: { length: "other_length" }, free: "array_free" },
			},
			async: "aliasAsync",
		},
		array_mixed: {
			params: {
				out: { out: true, ...array },
				message: { out: true, string: { length: "message_length" } },
			},
			async: "mixedAsync",
		},
		array_null: { returns: array, async: "nullAsync" },
		array_callback: { returns: array, params: { callback: { callback: {} } } },
		array_existing: { returns: array, params: { callback: { callback: {} } } },
		array_wait: { returns: array, async: "waitAsync" },
		array_watch: {
			params: { callback: { nullable: true, callback: { replaced: true } } },
		},
		array_peek: { returns: { borrowed: true } },
		resource_borrow: { returns: { borrowed: true } },
		buffer_alias: {
			returns: { string: true, free: "buffer_free_first" },
			params: { other: { out: true, string: true, free: "buffer_free_second" } },
			async: "bufferAliasAsync",
		},
	},
} satisfies MaligatorLibraryContract;
