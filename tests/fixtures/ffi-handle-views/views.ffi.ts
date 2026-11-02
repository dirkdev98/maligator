import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["views.h"],
	find: [{ includeDirs: ["."], sources: ["views.c"] }],
	types: {
		ViewBase: {
			handle: { destroy: "views_close_base" },
			fields: { read: { callable: { lifetime: "owner" } } },
		},
		ViewMiddle: { handle: { views: ["ViewBaseAlias"] } },
		ViewDerived: {
			handle: { views: ["ViewMiddle"], destroy: "views_close_derived" },
			fields: {
				scale: { callable: { lifetime: "owner" } },
				invoke: { callable: { lifetime: "owner", params: { "2": { callback: {} } } } },
			},
		},
		ViewSibling: { handle: { views: ["ViewBase"] } },
		ViewCaller: { handle: { storage: "caller", views: ["ViewBase"] } },
		ViewUnrelated: { handle: {} },
		ViewCopied: { handle: {} },
	},
	functions: {
		views_pending: { returns: { borrowed: true } },
		views_base: { returns: { borrowed: true } },
		views_sibling: { returns: { borrowed: true } },
		views_visit: { params: { callback: { callback: { data: "data" } } } },
		views_lend: { params: { callback: { callback: { data: "data" } } } },
		views_nested: { params: { callback: { callback: { data: "data" } } } },
	},
} satisfies MaligatorLibraryContract;
