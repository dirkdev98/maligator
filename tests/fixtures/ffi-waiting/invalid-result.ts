import {
	waiting_set_record,
	waiting_start,
	waiting_expect_zero,
	waiting_join_async,
} from "maligator:ffi/waiting";
waiting_set_record(() => ({ x: 37, y: "invalid" as unknown as number }));
waiting_expect_zero();
waiting_start(1, 1, 1);
await waiting_join_async();
throw new Error("an invalid callback result must throw");
