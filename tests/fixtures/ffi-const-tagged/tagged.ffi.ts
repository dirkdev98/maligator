import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["tagged.h"],
	find: [{ includeDirs: ["."], sources: ["tagged.c"] }],
	types: {
		ConstTagged: {
			shape: {
				tag: "kind",
				cases: {
					"0": [],
					"1": ["payload.integer"],
					"2": ["payload.point"],
					"3": ["payload.samples"],
				},
			},
		},
		ConstOverlap: { shape: { tag: "kind", cases: { "1": ["payload"] } } },
		ConstPromotedOverlap: { shape: { tag: "kind", cases: { "1": ["payload"] } } },
	},
	functions: {
		tagged_make: { async: "makeAsync" },
		tagged_take: { async: "takeAsync" },
		tagged_out: { params: { value: { out: true } }, async: "outAsync" },
		tagged_inout: { params: { value: { inout: true } }, async: "inoutAsync" },
		tagged_sum: { params: { values: { array: { length: "count" } } }, async: "sumAsync" },
		tagged_pair: { async: "pairAsync" },
		tagged_pair_inout: { params: { value: { inout: true } }, async: "pairInoutAsync" },
		tagged_visit: {
			params: { callback: { callback: { data: "data" } } },
			async: "visitAsync",
		},
		tagged_notify: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
			async: "notifyAsync",
		},
		tagged_callback: { params: { callback: { callback: {} } } },
	},
} satisfies MaligatorLibraryContract;
