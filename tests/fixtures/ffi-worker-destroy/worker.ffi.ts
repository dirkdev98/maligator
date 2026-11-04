import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["worker.h"],
	find: [{ includeDirs: ["."], sources: ["worker.c"] }],
	types: {
		WorkerResource: { handle: { destroy: "worker_close", collect: true } },
		RetryResource: {
			handle: { destroy: { function: "worker_retry_close", success: "true" } },
		},
		ReusedResource: { handle: { destroy: "worker_reused_close", collect: true } },
	},
	functions: {
		worker_open: { returns: { fresh: true } },
		worker_alias: { returns: { borrowed: true } },
		worker_native_open: { returns: { fresh: true } },
		worker_close: { async: "worker_close_async" },
		worker_retry_close: { async: "worker_retry_close_async" },
		worker_reused_open: { returns: { fresh: true } },
		worker_reused_alias: { returns: { borrowed: true } },
		worker_reused_close: { async: "worker_reused_close_async" },
		worker_reused_listen: { params: { callback: { callback: { replaced: true } } } },
		worker_watch: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
		},
		worker_watch_direct: {
			params: { callback: { callback: { data: "data", release: "release" } } },
		},
	},
} satisfies MaligatorLibraryContract;
