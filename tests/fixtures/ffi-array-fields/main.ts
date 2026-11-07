/* oxlint-disable no-console -- The fixture reports array field reads. */
import { empty_specs, sort_specs, sort_specs_set_count } from "maligator:ffi/sorting";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

const specs = sort_specs();
check(specs !== null, "borrowed specs");
const first = specs.specs;
check(first !== null && first.length === 2, "count field sizes the array");
check(first[0]!.column === 2 && first[0]!.direction === 1, "first record");
check(first[1]!.column === 0 && first[1]!.direction === -1, "second record");
check(specs.order?.join(",") === "3,1,2,0", "numeric array field");
// A helper keeps TypeScript from narrowing a member that C changes.
const count = (): number => specs.count;
check(count() === 2 && specs.weight === 0.75, "value fields read the library's members");

sort_specs_set_count(3);
check(
	specs.specs?.length === 3 && specs.specs[2]!.column === 5,
	"each read follows C's count",
);
check(first.length === 2, "an earlier read is a copy");
check(count() === 3, "a value field follows C's member");

check(empty_specs()?.specs === null, "a null pointer reads as null");

sort_specs_set_count(-1);
let caught: unknown;
try {
	void specs.specs;
} catch (error) {
	caught = error;
}
check(caught instanceof RangeError, `a negative count throws: ${String(caught)}`);
sort_specs_set_count(2);

console.log("array fields passed");
