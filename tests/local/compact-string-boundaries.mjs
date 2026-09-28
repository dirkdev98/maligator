import { isAbsolute, join, resolve } from "node:path";

console.log(isAbsolute("/compact/path"), join("/compact", "path"), resolve("/compact", "path"));
