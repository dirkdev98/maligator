/* oxlint-disable no-console -- The fixture reports linked C export behavior. */
import * as values from "maligator:ffi/values";
import { answer } from "./bridge.ts";

const total = Object.values(values).reduce<number>(
	(sum, value) => sum + (typeof value === "function" ? value() : value),
	0,
);
if (total !== 43) throw new Error("namespace exports changed");
console.log(answer(35), total);
