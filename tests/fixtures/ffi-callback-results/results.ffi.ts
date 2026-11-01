import type {
	MaligatorFfiCallback,
	MaligatorLibraryContract,
} from "../../../src/public-api.d.ts";

const text = {
	data: "data",
	returns: { lifetime: "call", nullable: true },
} satisfies MaligatorFfiCallback;
const counted = {
	data: "data",
	returns: { lifetime: "call", string: { length: "1" }, nullable: true },
} satisfies MaligatorFfiCallback;
// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["results.h"],
	find: [{ includeDirs: ["."], sources: ["results.c"] }],
	functions: {
		result_cancel: {
			async: "result_cancel_async",
			params: { callback: { callback: counted } },
		},
		result_scalar: { params: { callback: { callback: {} } } },
		result_text: { async: "result_text_async", params: { callback: { callback: text } } },
		result_required: {
			params: { callback: { callback: { ...text, returns: { lifetime: "call" } } } },
		},
		result_scoped: {
			async: "result_scoped_async",
			params: { callback: { callback: { returns: { lifetime: "call" } } } },
		},
		result_counted: {
			async: "result_counted_async",
			params: { callback: { callback: counted } },
			returns: { string: { length: "length" } },
		},
		result_bytes: {
			async: "result_bytes_async",
			params: {
				callback: {
					callback: {
						data: "data",
						returns: { lifetime: "call", bytes: { length: "1" }, nullable: true },
					},
				},
			},
			returns: { bytes: { length: "length" } },
		},
		result_parallel: {
			async: "result_parallel_async",
			params: { callback: { callback: text } },
		},
		result_shutdown: {
			async: "result_shutdown_async",
			params: { callback: { callback: text } },
		},
		result_bad_count: {
			async: "result_bad_count_async",
			params: { callback: { callback: counted } },
		},
	},
} satisfies MaligatorLibraryContract;
