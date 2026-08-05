// eslint-disable-next-line import-x/consistent-type-specifier-style -- native compact-strip acceptance fixture.
import { describeValues, type DescriptionInput } from "./format.ts";
import { fibonacci, total } from "./math.ts";

const values = [fibonacci(7), total([3, 5, 8])];
const report: DescriptionInput = { label: "native", values };
// eslint-disable-next-line no-console -- fixture output is the acceptance protocol.
console.log(describeValues(report.label, report.values));
