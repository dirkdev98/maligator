import { describeValues } from "./format.ts";
import { fibonacci, total } from "./math.ts";
import type { Report } from "./types.ts";

const values = [fibonacci(7), total([3, 5, 8])];
const report: Report = { label: "native", values };
// eslint-disable-next-line no-console -- fixture output is the acceptance protocol.
console.log(describeValues(report.label, report.values));
