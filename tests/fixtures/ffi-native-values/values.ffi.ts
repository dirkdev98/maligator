import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["values.h"],
	find: [{ includeDirs: ["."], sources: ["values.c"] }],
	types: {
		NativeSigned: { representation: "native" },
		NativeUnsigned: { representation: "native" },
		NativeOtherUnsigned: { representation: "native" },
		NativeExtended: { representation: "native" },
		NativeChoice: { shape: { member: "integer" } },
	},
	globals: {
		native_unsigned_global: { get: "getUnsignedGlobal", set: "setUnsignedGlobal" },
		native_const_unsigned: { get: "getConstUnsigned" },
		native_const_values: { get: "getConstValues" },
	},
	functions: {
		native_with_callback: { params: { callback: { callback: { data: "data" } } } },
		native_unsigned_make: { async: "makeUnsignedAsync" },
		native_signed_min: { async: "signedMinAsync" },
		native_precise: { async: "preciseAsync" },
		native_record: { async: "recordAsync" },
		native_record_check: { async: "checkRecordAsync" },
		native_const_record: { async: "constRecordAsync" },
		native_const_record_check: { async: "checkConstRecordAsync" },
		native_choice: { async: "choiceAsync" },
		native_choice_check: { async: "checkChoiceAsync" },
		native_unsigned_out: { params: { value: { out: true } }, async: "unsignedOutAsync" },
		native_unsigned_inout: {
			params: { value: { inout: true } },
			async: "unsignedInoutAsync",
		},
		native_unsigned_sum: {
			params: { values: { array: { length: "count" } } },
			async: "sumUnsignedAsync",
		},
		native_unsigned_array: {
			returns: { array: { length: "count" }, free: "native_array_free" },
			async: "arrayUnsignedAsync",
		},
		native_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackAsync",
		},
		native_parallel: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: "wait" } },
			},
			async: "parallelAsync",
		},
		native_notify: {
			params: {
				callback: { callback: { data: "data", release: "release", queued: true } },
			},
		},
	},
} satisfies MaligatorLibraryContract;
