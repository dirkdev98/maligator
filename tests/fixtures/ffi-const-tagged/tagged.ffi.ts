import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["tagged.h"],
	find: [{ includeDirs: ["."], sources: ["tagged.c"] }],
	types: {
		ConstBadOffset: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstBadWidth: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstOffsetEvent: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstNestedEvent: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstBitEvent: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstBadPrefix: { shape: { tag: "kind", cases: { "1": ["point"] } } },
		ConstEvent: {
			shape: {
				tag: "kind",
				cases: { "0": ["point"], "1": ["point"], "2": ["integer"], "3": [] },
			},
		},
		ConstPromotedEvent: { shape: { tag: "kind", cases: { "1": ["point"], "3": [] } } },
		ConstIncompatibleOverlap: { shape: { tag: "kind", cases: { "1": ["payload"] } } },
		ConstIncompatiblePromotedOverlap: {
			shape: { tag: "kind", cases: { "1": ["payload"] } },
		},
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
		event_make: { async: "makeEventAsync" },
		event_take: { async: "takeEventAsync" },
		event_identity: { async: "identityEventAsync" },
		event_out: { params: { value: { out: true } }, async: "outEventAsync" },
		event_inout: { params: { value: { inout: true } }, async: "inoutEventAsync" },
		event_sum: {
			params: { values: { array: { length: "count" } } },
			async: "sumEventsAsync",
		},
		event_visit: {
			params: { callback: { callback: { data: "data" } } },
			async: "visitEventAsync",
		},
		event_callback: {
			params: { callback: { callback: {} } },
			async: "callbackEventAsync",
		},
		event_notify: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
			async: "notifyEventAsync",
		},
		event_callback_error: {
			params: { callback: { callback: {} } },
			async: "callbackEventErrorAsync",
		},
		promoted_event_make: { async: "makePromotedEventAsync" },
		promoted_event_take: { async: "takePromotedEventAsync" },
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
		tagged_callback: { params: { callback: { callback: {} } }, async: "callbackAsync" },
	},
} satisfies MaligatorLibraryContract;
