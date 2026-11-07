/* oxlint-disable no-console -- The fixture reports typed pointee calls. */
import {
	scalarStep,
	scalar_clamp_double,
	scalar_step_double,
	scalar_step_int,
} from "maligator:ffi/scalars";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

const stepped = scalar_step_double(1.5);
check(stepped.result === 1 && stepped.value === 2, "double variant");
const counted = scalar_step_int(41);
check(counted.result === 0 && counted.value === 42, "int variant");
let caught: unknown;
try {
	scalar_step_int(1.5);
} catch (error) {
	caught = error;
}
check(caught instanceof RangeError, "an int pointee rejects fractions");
check(scalarStep("scalar_step_double", 0).value === 0.5, "dispatch to a typed variant");
check(scalar_clamp_double(5, 0, 2.5).value === 2.5, "const pointees read their inputs");

console.log("typed pointees passed");
