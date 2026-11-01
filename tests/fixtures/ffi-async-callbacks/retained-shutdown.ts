import {
	async_release_after_async,
	async_retained_arm_shutdown,
	async_retained_wait,
} from "maligator:ffi/callbacks";

async_retained_arm_shutdown();
for (let index = 0; index < 256; index++) {
	async_release_after_async(index, () => {
		throw new Error("shutdown ran a retained callback");
	}).catch(() => {});
}
async_retained_wait();
throw new Error("async callback shutdown requested");
