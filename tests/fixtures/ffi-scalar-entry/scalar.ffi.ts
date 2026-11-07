// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["scalar.h"],
	find: [{ includeDirs: ["."], sources: ["scalar.c"] }],
	functions: {
		scalar_dot: {
			params: {
				left: { array: { length: "count" } },
				right: { array: { length: "count" } },
			},
		},
		scalar_scale: { params: { values: { array: { length: "count", writable: true } } } },
		scalar_sum_u8: { params: { bytes: { array: { length: "count" } } } },
		scalar_empty: { params: { values: { array: { length: "count" } } } },
		scalar_at: { params: { values: { array: { length: "count" } } } },
	},
};
