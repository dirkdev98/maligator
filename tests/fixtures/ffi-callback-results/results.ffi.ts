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
	types: {
		ResultResource: { handle: { destroy: "result_resource_free", collect: true } },
		ResultState: {
			handle: { storage: "caller" },
			fields: {
				bytes: { bytes: { length: "length" } },
				text: { string: { length: "text_length" } },
			},
		},
	},
	functions: {
		result_handles_shutdown: {
			async: "result_handles_shutdown_async",
			params: {
				resource: { callback: { data: "resource_data", returns: { lifetime: "call" } } },
				state: { callback: { data: "state_data", returns: { lifetime: "call" } } },
			},
		},
		result_handle: {
			async: "result_handle_async",
			params: {
				callback: {
					callback: { data: "data", returns: { lifetime: "call", nullable: true } },
				},
			},
			returns: { borrowed: true },
		},
		result_state: {
			async: "result_state_async",
			params: {
				callback: {
					callback: { data: "data", returns: { lifetime: "call", nullable: true } },
				},
			},
			returns: { borrowed: true },
		},
		result_lend_handle: {
			params: {
				callback: {
					callback: {
						data: "data",
						returns: { lifetime: "call" },
					},
				},
			},
		},
		result_retain: {
			async: "result_retain_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: "wait",
						returns: { lifetime: "registration", nullable: true },
					},
				},
			},
		},
		result_retained_call: { async: "result_retained_call_async" },
		result_retained_clear: { async: "result_retained_clear_async" },
		result_replace: {
			async: "result_replace_async",
			params: {
				callback: {
					nullable: true,
					callback: {
						replaced: true,
						queued: "wait",
						returns: { lifetime: "registration", nullable: true },
					},
				},
			},
		},
		result_replaced_call: { async: "result_replaced_call_async" },
		result_retain_bytes: {
			async: "result_retain_bytes_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: "wait",
						returns: { lifetime: "registration", bytes: { length: "1" }, nullable: true },
					},
				},
			},
		},
		result_retained_bytes_call: { async: "result_retained_bytes_call_async" },
		result_retained_bytes_clear: { async: "result_retained_bytes_clear_async" },
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
