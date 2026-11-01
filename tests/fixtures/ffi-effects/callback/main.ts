/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import { effects_scope, effects_nested } from "maligator:ffi/callbacks";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
let calls = 0;
let state = 3;
effects_scope(() => {
	calls++;
	if (calls === 1) {
		check(effects_nested() === 1, "nested C call returns");
		check(state === 99, "a call-scoped callback can reenter through another C function");
	} else state = 99;
});
check(calls === 2 && state === 99, "nested callback writes survive C boundaries");
console.log("nested foreign callback passed");
