import * as c from "maligator:ffi/results";

void c.result_shutdown_async(() => {
	setTimeout(() => {
		throw new Error("pointer shutdown requested");
	}, 0);
	return "native-kept";
});
