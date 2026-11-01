import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

const callback = { data: "data" };
// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["async.h"],
	find: [{ includeDirs: ["."], sources: ["async.c"] }],
	types: { AsyncResource: { handle: { destroy: "async_resource_destroy" } } },
	functions: {
		async_register_lookup: {
			async: "async_register_lookup_async",
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						lookup: { function: "async_resource_data", param: "1" },
					},
				},
			},
		},
		async_release_after: {
			async: "async_release_after_async",
			params: { callback: { callback: { data: "data", release: "release" } } },
		},
		async_release_buffer: {
			async: "async_release_buffer_async",
			params: {
				callback: { callback: { data: "data", release: "release" } },
				bytes: { bytes: { length: "length" } },
			},
		},
		async_register: {
			async: "async_register_async",
			params: {
				callback: { callback: { data: "data", release: "release" }, nullable: true },
			},
		},
		async_registered_call: { async: "async_registered_call_async" },
		async_registered_clear: { async: "async_registered_clear_async" },
		async_notify: {
			async: "async_notify_async",
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
		},
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
