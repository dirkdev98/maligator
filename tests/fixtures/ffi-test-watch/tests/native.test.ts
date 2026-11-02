import { watch_arm_exit, watch_next, watch_value } from "maligator:ffi/watch";
import { expect, test } from "maligator:test";

test("calls native code", () => {
	watch_arm_exit();
	expect(watch_value()).toBe(1);
	expect(watch_next()).toBe(1);
});
