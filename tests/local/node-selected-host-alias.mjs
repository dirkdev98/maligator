import os from "node:os";
import path from "node:path";
import { format, join } from "node:path/posix";

console.log(path.join === join, format({ dir: "/fixtures", base: "reports" }));
console.log(Object.getOwnPropertyNames(os).includes("cpus"));
