import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["owner.h"],
	find: [{ includeDirs: ["."], sources: ["owner.c"] }],
	types: {
		OwnerBase: { handle: {} },
		OwnerResult: {
			handle: { destroy: "owner_result_destroy", collect: true },
			fields: {
				first: { handle: { lifetime: "owner" } },
				second: { handle: { lifetime: "owner" } },
				empty: { handle: { lifetime: "owner" } },
				library: { handle: { lifetime: "library" } },
			},
		},
		OwnerChild: {
			handle: { destroy: "owner_child_free", collect: true, views: ["OwnerBase"] },
			fields: { next: { handle: { lifetime: "owner" } } },
		},
	},
	functions: {
		owner_result_new: { async: "newResultAsync" },
		owner_result_destroy: { async: "destroyResultAsync" },
		owner_child_free: { async: "destroyChildAsync" },
		owner_child_alias: { returns: { borrowed: true } },
		owner_child_wait: { async: "waitChildAsync" },
		owner_result_wait: { async: "waitResultAsync" },
		owner_result_base: { returns: { borrowed: true } },
		owner_lend_child: { params: { callback: { callback: { data: "data" } } } },
		owner_lend_result: { params: { callback: { callback: { data: "data" } } } },
		owner_visit_result: {
			params: { callback: { callback: { data: "data", returns: { lifetime: "call" } } } },
		},
		owner_watch_child: {
			params: {
				callback: {
					nullable: true,
					callback: { data: "data", release: "release", queued: "wait" },
				},
			},
			async: "watchChildAsync",
		},
		owner_replace_child: {
			params: {
				callback: {
					nullable: true,
					callback: { data: "data", replaced: true, queued: "wait" },
				},
			},
			async: "replaceChildAsync",
		},
		owner_child_visit: { params: { callback: { callback: { data: "data" } } } },
		owner_result_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "resultCallbackAsync",
		},
		owner_keep_child: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						queued: "wait",
						returns: { lifetime: "registration" },
					},
				},
			},
			async: "keepChildAsync",
		},
	},
} satisfies MaligatorLibraryContract;
