import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["unions.h"],
	find: [{ includeDirs: ["."], sources: ["unions.c"] }],
	types: {
		Scalar: { shape: { member: "integer" } },
		Resource: { handle: {} },
		ResourceParent: { handle: {} },
		ResourcePayload: { shape: { member: "resources" } },
	},
	functions: {
		resources_visit: {
			async: "resources_visit_async",
			params: { visit: { callback: {} } },
		},
		resources_record_visit: {
			async: "resources_record_visit_async",
			params: { visit: { callback: {} } },
		},
		scalar_integer: { async: "scalar_integer_async" },
		scalar_real: {
			params: { value: { shape: { member: "real" } } },
			returns: { shape: { member: "real" } },
		},
		scalar_wide: {
			params: { value: { shape: { member: "wide" } } },
			returns: { shape: { member: "wide" } },
		},
		scalar_bits: {
			params: { value: { shape: { member: "bits" } } },
			returns: { shape: { member: "bits" } },
		},
		scalar_point: {
			params: { value: { shape: { member: "point" } } },
			returns: { shape: { member: "point" } },
		},
		scalar_items: {
			params: { value: { shape: { member: "items" } } },
			returns: { shape: { member: "items" } },
		},
		scalar_update: { params: { value: { inout: true, shape: { member: "real" } } } },
		scalar_out: { params: { value: { out: true, shape: { member: "wide" } } } },
		scalar_many: { params: { values: { array: { length: "count" } } } },
		scalar_real_many: {
			params: { values: { array: { length: "count" }, shape: { member: "real" } } },
		},
		scalar_arrays: {
			returns: { array: { length: "count" }, shape: { member: "items" } },
		},
		scalar_visit: {
			async: "scalar_visit_async",
			params: {
				value: { shape: { member: "point" } },
				visit: {
					callback: {
						params: { "1": { shape: { member: "point" } } },
						returns: { shape: { member: "point" } },
					},
				},
			},
		},
	},
} satisfies MaligatorLibraryContract;
