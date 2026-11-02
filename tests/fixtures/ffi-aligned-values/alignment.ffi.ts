import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

const array = { params: { values: { array: { length: "count" } } } };
// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["aligned.h"],
	find: [{ includeDirs: ["."], sources: ["aligned.c"] }],
	globals: {
		aligned_values: { get: "getValues", set: "setValues" },
		aligned_huge_values: { get: "getHugeValues", set: "setHugeValues" },
	},
	functions: {
		aligned_address: { ...array, async: "aligned_address_async" },
		aligned_huge_address: array,
		aligned_sum: { ...array, async: "aligned_sum_async" },
		aligned_echo: { async: "aligned_echo_async" },
		aligned_apply: {
			async: "aligned_apply_async",
			params: { callback: { callback: { data: "data" } } },
		},
		aligned_transform: {
			async: "aligned_transform_async",
			params: { callback: { callback: { data: "data" } } },
		},
		aligned_notify: {
			async: "aligned_notify_async",
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
		},
	},
} satisfies MaligatorLibraryContract;
