// oxlint-disable-next-line import/no-default-export -- library contract fixture
export default {
	headers: ["callables.h"],
	find: [{ includeDirs: ["."], sources: ["callables.c"] }],
	functions: {
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
import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
