import { callbackShutdownAsync, a_make } from "maligator:ffi/const_values";
void callbackShutdownAsync(() => {
	setTimeout(() => {
		throw new Error("const shutdown requested");
	}, 0);
	return a_make(13);
});
