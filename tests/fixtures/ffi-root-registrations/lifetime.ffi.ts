import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["lifetime.h"],
	find: [{ includeDirs: ["."], sources: ["lifetime.c"] }],
	types: {
		LifeRoot: {
			handle: { destroy: "life_destroy", collect: true },
			fields: { child: { handle: { lifetime: "owner" } } },
		},
		RetryRoot: {
			handle: { destroy: { function: "retry_destroy", success: "1" } },
			fields: { child: { handle: { lifetime: "owner" } } },
		},
		LifeChild: { handle: {} },
	},
	functions: {
		life_subscribe_notice: {
			params: {
				callback: {
					callback: { owner: "child", data: "data", release: "release", queued: true },
				},
			},
		},
		life_subscribe_result: {
			params: {
				callback: {
					callback: {
						owner: "child",
						data: "data",
						release: "release",
						returns: { lifetime: "registration" },
					},
				},
			},
		},
		life_subscribe: {
			params: {
				child: { nullable: true },
				callback: { callback: { owner: "child", data: "data", release: "release" } },
			},
		},
		life_subscribe_queued: {
			params: {
				callback: {
					callback: { owner: "1", data: "data", release: "release", queued: "wait" },
				},
			},
			async: "subscribeQueuedAsync",
		},
		life_replace: {
			params: {
				callback: {
					nullable: true,
					callback: { owner: "child", data: "data", replaced: true },
				},
			},
		},
		life_fire_thread: { async: "fireThreadAsync" },
		life_destroy: { async: "destroyAsync" },
		life_keep_root: {
			params: {
				callback: {
					callback: {
						data: "data",
						release: "release",
						returns: { lifetime: "registration" },
					},
				},
			},
		},
	},
} satisfies MaligatorLibraryContract;
