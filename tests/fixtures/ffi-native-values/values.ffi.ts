import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";
// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	headers: ["values.h"],
	find: [{ includeDirs: ["."], sources: ["values.c"] }],
	types: {
		NativeComplex: { representation: "native" },
		NativeVector: { representation: "native" },
		NativeTriple: { representation: "native" },
		NativeGnuVector: { representation: "native" },
		NativeAlignedTriple: { representation: "native" },
		NativeBits: { representation: "native" },
		NativeSignedBits: { representation: "native" },
		NativeWideBits: { representation: "native" },
		NativeSigned: { representation: "native" },
		NativeUnsigned: { representation: "native" },
		NativeOtherUnsigned: { representation: "native" },
		NativeExtended: { representation: "native" },
		NativeChoice: { shape: { member: "integer" } },
	},
	globals: {
		native_complex_global: { get: "getComplexGlobal", set: "setComplexGlobal" },
		native_unsigned_global: { get: "getUnsignedGlobal", set: "setUnsignedGlobal" },
		native_const_unsigned: { get: "getConstUnsigned" },
		native_const_values: { get: "getConstValues" },
	},
	functions: {
		native_complex_make: { async: "makeComplexAsync" },
		native_complex_identity: { async: "identityComplexAsync" },
		native_vector_make: { async: "makeVectorAsync" },
		native_triple_make: { async: "makeTripleAsync" },
		native_gnu_make: { async: "makeGnuAsync" },
		native_aligned_triple: { async: "makeAlignedAsync" },
		native_bits_max: { async: "bitsMaxAsync" },
		native_wide_bits_max: { async: "wideBitsMaxAsync" },
		native_signed_bits_min: { async: "signedBitsMinAsync" },
		native_extension_record: { async: "extensionRecordAsync" },
		native_extension_record_check: { async: "checkExtensionRecordAsync" },
		native_triple_inout: {
			params: { value: { inout: true } },
			async: "inoutTripleAsync",
		},
		native_complex_out: { params: { value: { out: true } }, async: "outComplexAsync" },
		native_triples_sum: {
			params: { values: { array: { length: "count" } } },
			async: "sumTriplesAsync",
		},
		native_complex_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackComplexAsync",
		},
		native_triple_callback: {
			params: { callback: { callback: { data: "data" } } },
			async: "callbackTripleAsync",
		},
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
