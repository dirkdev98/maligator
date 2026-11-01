import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["state.h"],
	find: [{ includeDirs: ["."], sources: ["state.c"] }],
	types: {
		ManagedResource: { handle: { destroy: "managed_resource_free", collect: true } },
		ManagedBase: { handle: {} },
		ManagedState: {
			handle: { storage: "caller", views: ["ManagedBase"] },
			fields: {
				next_in: { bytes: { length: "avail_in", writable: false } },
				next_out: { bytes: { length: "avail_out" } },
			},
		},
		ManagedNarrow: {
			handle: { storage: "caller" },
			fields: { data: { bytes: { length: "length" } } },
		},
		ManagedSigned: {
			handle: { storage: "caller" },
			fields: { data: { bytes: { length: "length" } } },
		},
	},
	functions: {
		managed_lend: { params: { callback: { callback: { data: "data" } } } },
		managed_many: { params: { states: { array: { length: "count" } } } },
		managed_many_wait: {
			params: { states: { array: { length: "count" } } },
			async: "managed_many_async",
		},
		managed_indirect: {
			params: { state: { inout: true } },
			async: "managed_indirect_async",
		},
		managed_remaining: {
			params: { length: { out: true } },
			returns: { bytes: { length: "length" } },
			async: "managed_remaining_async",
		},
		managed_packet: { params: { callback: { callback: { data: "data" } } } },
		managed_packet_wait: { async: "managed_packet_async" },
		managed_copy_slow: { async: "managed_copy_slow_async" },
		managed_abi_size: { params: { size: { sizeof: "ManagedState" } } },
		managed_copy_wait: { async: "managed_copy_async" },
		managed_visit: { params: { callback: { callback: { data: "data" } } } },
	},
} satisfies MaligatorLibraryContract;
