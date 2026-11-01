import { Worker } from "node:worker_threads";
import {
	waiting_set_integer,
	waiting_arm_child,
	waiting_wait_child,
} from "maligator:ffi/waiting";
waiting_set_integer(() => {
	throw new Error("a canceled parent callback must not run");
});
waiting_arm_child();
new Worker(new URL("./child.ts", import.meta.url));
waiting_wait_child();
throw new Error("waiting child shutdown requested");
