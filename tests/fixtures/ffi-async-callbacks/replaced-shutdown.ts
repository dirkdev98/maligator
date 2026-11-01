import process from "node:process";
import {
	async_replace,
	async_replace_async,
	async_replaced_arm_shutdown,
	async_replaced_wait,
	async_release_after_async,
	async_retained_arm_shutdown,
	async_retained_wait,
} from "maligator:ffi/callbacks";

async_replace(0, () => {
	throw new Error("shutdown ran an old replacement");
});
if (process.argv[2] === "queued") {
	async_replaced_arm_shutdown(1);
	async_retained_arm_shutdown();
	for (let index = 0; index < 64; index++)
		async_release_after_async(index, () => 1).catch(() => {});
	async_replace_async(0, () => 2).catch(() => {});
	async_retained_wait();
} else {
	async_replaced_arm_shutdown(2);
	async_replace_async(1, () => 2).catch(() => {});
	async_replaced_wait();
}
throw new Error("async callback shutdown requested");
