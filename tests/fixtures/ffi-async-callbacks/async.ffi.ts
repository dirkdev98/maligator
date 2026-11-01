import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

const callback = { data: "data" };
// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["async.h"],
	find: [{ includeDirs: ["."], sources: ["async.c"] }],
	types: { AsyncResource: { handle: { destroy: "async_resource_destroy" } } },
	functions: {
		async_bytes_count: {
			async: "async_bytes_count_async",
			params: {
				callback: {
					callback: { data: "data", params: { "1": { bytes: { length: "2" } } } },
				},
			},
		},
		async_apply: { async: "async_apply_async", params: { callback: { callback } } },
		async_parallel: { async: "async_parallel_async", params: { callback: { callback } } },
		async_plain: { async: "async_plain_async", params: { callback: { callback: {} } } },
		async_void: { async: "async_void_async", params: { callback: { callback } } },
		async_record: { async: "async_record_async", params: { callback: { callback } } },
		async_owned: {
			async: "async_owned_async",
			params: { callback: { callback } },
			returns: { string: true, free: "async_free" },
		},
		async_resource: { async: "async_resource_async", params: { callback: { callback } } },
		async_outputs: {
			async: "async_outputs_async",
			params: {
				callback: { callback },
				text: { out: true, string: true, free: "async_free" },
			},
		},
		async_touch: {
			async: "async_touch_async",
			params: { bytes: { bytes: { length: "length" } }, callback: { callback } },
		},
		async_shutdown: { async: "async_shutdown_async", params: { callback: { callback } } },
		async_shutdown_owned: {
			async: "async_shutdown_owned_async",
			params: { callback: { callback } },
			returns: { string: true, free: "async_free" },
		},
		async_shutdown_resource: {
			async: "async_shutdown_resource_async",
			params: { callback: { callback } },
		},
		async_shutdown_outputs: {
			async: "async_shutdown_outputs_async",
			params: {
				callback: { callback },
				text: { out: true, string: true, free: "async_free" },
			},
		},
	},
} satisfies MaligatorLibraryContract;
