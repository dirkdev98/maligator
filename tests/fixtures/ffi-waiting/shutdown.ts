import { waiting_set_integer, waiting_arm_shutdown } from "maligator:ffi/waiting";
waiting_set_integer(() => {
	throw new Error("a canceled callback must not run");
});
waiting_arm_shutdown();
throw new Error("waiting shutdown requested");
