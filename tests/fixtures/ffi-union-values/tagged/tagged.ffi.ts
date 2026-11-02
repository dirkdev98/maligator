import type { MaligatorLibraryContract } from "../../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["tagged.h"],
	find: [{ includeDirs: ["."], sources: ["tagged.c"] }],
	types: {
		Tagged: {
			shape: {
				tag: "kind",
				cases: {
					PRIVATE_TAG_INTEGER: ["payload.integer"],
					PRIVATE_TAG_POINT: ["payload.point"],
					PRIVATE_TAG_DONE: [],
				},
			},
		},
		Anonymous: { shape: { tag: "kind", cases: { "1": ["integer"], "2": ["point"] } } },
		Multiple: {
			shape: {
				tag: "kind",
				cases: {
					"1": ["left_integer", "right_real"],
					"2": ["left_real", "right_integer"],
					"7": [],
				},
			},
		},
		Root: { shape: { tag: "kind", cases: { "1": ["point"], "2": ["integer"] } } },
		WideTag: { shape: { tag: "kind", cases: { PRIVATE_WIDE_TAG: ["payload.integer"] } } },
		BoolTag: {
			shape: { tag: "kind", cases: { "0": ["payload.integer"], "1": ["payload.real"] } },
		},
		Owner: { handle: { destroy: "owner_destroy" } },
		DefaultOuter: { shape: { tag: "kind", cases: { "1": ["payload.inner"] } } },
		DefaultPayload: { shape: { member: "integer" } },
		Defaulted: { shape: { tag: "kind", cases: { "1": ["payload.integer"], "2": [] } } },
		SignedTag: {
			shape: { tag: "kind", cases: { "-9223372036854775808": ["payload.integer"] } },
		},
		PromotedTag: { shape: { tag: "kind", cases: { "1": ["integer"], "2": ["point"] } } },
		Deep: {
			shape: {
				tag: "kind",
				cases: { "1": ["payload.inner.point"], "2": ["payload.inner.integer"] },
			},
		},
		Envelope: {
			shape: { tag: "kind", cases: { "1": ["payload.event"], "2": ["payload.integer"] } },
		},
		Nested: {
			shape: {
				tag: "kind",
				cases: { "1": ["box.data.integer"], "2": ["box.data.point"] },
			},
		},
		Resource: { handle: {} },
		TaggedResource: {
			shape: { tag: "kind", cases: { "1": ["payload.items"], "2": ["payload.integer"] } },
		},
	},
	functions: {
		tagged_echo: { async: "tagged_echo_async" },
		tagged_out: { params: { value: { out: true } } },
		tagged_update: { params: { value: { inout: true } } },
		tagged_many: { params: { values: { array: { length: "count" } } } },
		tagged_array: { returns: { array: { length: "count" } } },
		tagged_visit: { async: "tagged_visit_async", params: { visit: { callback: {} } } },
		resource_visit: {
			async: "resource_visit_async",
			params: { visit: { callback: {} } },
		},
	},
} satisfies MaligatorLibraryContract;
