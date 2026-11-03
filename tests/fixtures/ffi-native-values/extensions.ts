/* oxlint-disable no-console -- The fixture reports observable extension ABI behavior. */
import {
	NativeComplex,
	NativeTriple,
	NativeGnuVector,
	NATIVE_COMPLEX_ONE,
	NATIVE_TRIPLE_ONE,
	native_complex_make,
	makeComplexAsync,
	native_complex_check,
	native_complex_identity,
	identityComplexAsync,
	native_vector_make,
	makeVectorAsync,
	native_vector_sum,
	native_triple_make,
	makeTripleAsync,
	native_triple_sum,
	native_gnu_make,
	makeGnuAsync,
	native_gnu_sum,
	native_aligned_triple,
	makeAlignedAsync,
	native_aligned_sum,
	native_bits_max,
	bitsMaxAsync,
	native_bits_check,
	native_wide_bits_max,
	wideBitsMaxAsync,
	native_wide_bits_check,
	native_signed_bits_min,
	signedBitsMinAsync,
	native_signed_bits_check,
	native_extension_record,
	extensionRecordAsync,
	native_extension_record_check,
	checkExtensionRecordAsync,
	native_triple_inout,
	inoutTripleAsync,
	native_complex_out,
	outComplexAsync,
	native_triples_sum,
	sumTriplesAsync,
	native_complex_callback,
	callbackComplexAsync,
	native_triple_callback,
	callbackTripleAsync,
	getComplexGlobal,
	setComplexGlobal,
} from "maligator:ffi/native_values";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
check(
	native_complex_check(NativeComplex()) === 0 &&
		native_triple_sum(NativeTriple()) === 0 &&
		native_gnu_sum(NativeGnuVector()) === 0,
	"native extension factories initialize arithmetic zero",
);
check(
	native_complex_check(NATIVE_COMPLEX_ONE) === 0 &&
		native_triple_sum(NATIVE_TRIPLE_ONE) === 6,
	"native complex and vector constants retain their typedefs",
);
for (const run of [native_complex_make, makeComplexAsync]) {
	const value = await run();
	check(
		native_complex_check(value) === 1 &&
			native_complex_check(native_complex_identity(value)) === 1 &&
			native_complex_check(await identityComplexAsync(value)) === 1,
		"complex components retain C long-double precision",
	);
}
for (const run of [native_vector_make, makeVectorAsync])
	check(native_vector_sum(await run()) === 17, "fixed integer vectors retain every lane");
for (const run of [native_triple_make, makeTripleAsync])
	check(
		native_triple_sum(await run()) === 10,
		"three-lane vectors preserve their padded native storage",
	);
for (const run of [native_gnu_make, makeGnuAsync])
	check(
		native_gnu_sum(await run()) === 17,
		"GNU vectors preserve the target calling convention",
	);
for (const run of [native_aligned_triple, makeAlignedAsync])
	check(
		native_aligned_sum(await run()) === 10,
		"native vector aliases retain stronger alignment",
	);
for (const run of [native_bits_max, bitsMaxAsync])
	check(
		native_bits_check(await run()) === 1,
		"unsigned bit-precise integers retain their logical width",
	);
for (const run of [native_signed_bits_min, signedBitsMinAsync])
	check(
		native_signed_bits_check(await run()) === 1,
		"signed nonstandard widths preserve negative extremes",
	);
for (const run of [native_wide_bits_max, wideBitsMaxAsync])
	check(
		native_wide_bits_check(await run()) === 1,
		"wide integers retain every bit at the compiler-supported width",
	);
for (const run of [native_extension_record, extensionRecordAsync]) {
	const value = await run();
	check(
		native_extension_record_check(value) === 1 &&
			(await checkExtensionRecordAsync(value)) === 1,
		"compound records retain extension values and alignment",
	);
}
const triple = native_triple_make();
for (const run of [native_triple_inout, inoutTripleAsync])
	check(
		native_triple_sum((await run(triple)).value) === 16 &&
			native_triple_sum(triple) === 10,
		"vector inout buffers hold independent copies",
	);
for (const run of [native_complex_out, outComplexAsync])
	check(
		native_complex_check((await run()).value) === 1,
		"complex output buffers retain both components",
	);
for (const run of [native_triples_sum, sumTriplesAsync])
	check((await run([triple, triple])) === 20, "vector arrays use native element stride");
setComplexGlobal(native_complex_make());
check(
	native_complex_check(getComplexGlobal()) === 1,
	"complex globals copy native values",
);
let complex: ReturnType<typeof native_complex_make> | undefined;
for (const run of [native_complex_callback, callbackComplexAsync]) {
	check(
		native_complex_check(
			await run((value) => {
				complex = value;
				return value;
			}),
		) === 1,
		"callbacks preserve complex calling conventions",
	);
}
check(
	complex !== undefined && native_complex_check(complex) === 1,
	"saved complex callback arguments survive callback return",
);
let vector: typeof triple | undefined;
for (const run of [native_triple_callback, callbackTripleAsync])
	check(
		native_triple_sum(
			await run((value) => {
				vector = value;
				return value;
			}),
		) === 10,
		"callbacks preserve padded vector results",
	);
check(
	vector !== undefined && native_triple_sum(vector) === 10,
	"saved vector callback values are independent copies",
);
const disposable = native_complex_make();
const pending = identityComplexAsync(disposable);
disposable[Symbol.dispose]();
check(
	native_complex_check(await pending) === 1,
	"workers retain complex values after source disposal",
);
console.log("native extensions passed");
