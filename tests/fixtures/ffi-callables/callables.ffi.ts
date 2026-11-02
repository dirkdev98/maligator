import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- library contract fixture
export default {
	headers: ["callables.h"],
	find: [{ includeDirs: ["."], sources: ["callables.c"] }],
	types: {
		CallableTable: {
			handle: { destroy: "callable_table_close", collect: true },
			fields: {
				transform: { callable: { lifetime: "owner" } },
				point: { callable: { lifetime: "owner" } },
				visit: { callable: { lifetime: "owner", params: { "2": { callback: {} } } } },
				self: { callable: { lifetime: "owner" } },
				abi: { callable: { lifetime: "owner" } },
				fixed: {
					callable: { lifetime: "owner", params: { "1": { constant: "CALLABLE_MODE" } } },
				},
				factory: {
					callable: { lifetime: "owner", returns: { callable: { lifetime: "library" } } },
				},
				independent: { callable: { lifetime: "library" } },
				owned_factory: {
					callable: { lifetime: "owner", returns: { callable: { lifetime: "owner" } } },
				},
			},
		},
		CallableState: {
			handle: { storage: "caller" },
			fields: {
				data: { bytes: { length: "size" } },
				run: { callable: { lifetime: "owner", params: { "3": { callback: {} } } } },
			},
		},
	},
	functions: {
		callable_table_hold: { async: "callable_table_hold_async" },
		callable_table_loan: { params: { visit: { callback: {} } } },
		callable_choose: {
			returns: { callable: { lifetime: "library" } },
			async: "callable_choose_async",
		},
		callable_anon: { returns: { callable: { lifetime: "library" } } },
		callable_from_point: { returns: { callable: { lifetime: "library" } } },
		callable_double: { returns: { callable: { lifetime: "library" } } },
		callable_point: { returns: { callable: { lifetime: "library" } } },
		callable_text: { returns: { callable: { lifetime: "library" } } },
		callable_abi: { returns: { callable: { lifetime: "library" } } },
		callable_abi_anon: { returns: { callable: { lifetime: "library" } } },
		callable_factory: {
			returns: {
				callable: { lifetime: "library", returns: { callable: { lifetime: "library" } } },
			},
		},
		callable_apply: {
			returns: { callable: { lifetime: "library", params: { "2": { callback: {} } } } },
		},
		callable_bytes: {
			returns: {
				callable: { lifetime: "library", params: { "1": { bytes: { length: "2" } } } },
			},
		},
		callable_fixed: {
			returns: {
				callable: { lifetime: "library", params: { "1": { constant: "CALLABLE_MODE" } } },
			},
		},
		callable_out: {
			returns: { callable: { lifetime: "library", params: { "2": { out: true } } } },
		},
	},
} satisfies MaligatorLibraryContract;
