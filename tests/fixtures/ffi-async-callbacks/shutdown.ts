import process from "node:process";
import {
	async_shutdown_async,
	async_shutdown_owned_async,
	async_shutdown_resource_async,
	async_shutdown_outputs_async,
	async_wait_entered,
} from "maligator:ffi/callbacks";
const invoke =
	process.argv[2] === "string"
		? async_shutdown_owned_async
		: process.argv[2] === "handle"
			? async_shutdown_resource_async
			: process.argv[2] === "out"
				? async_shutdown_outputs_async
				: async_shutdown_async;
void invoke(() => {
	throw new Error("a detached async callback must not run");
});
async_wait_entered();
throw new Error("async callback shutdown requested");
