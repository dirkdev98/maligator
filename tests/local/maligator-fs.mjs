import { file, FileSystemError } from "maligator:fs";
import { scenario } from "./maligator-fs-scenario.mjs";

console.log((await scenario({ file, FileSystemError, URL: globalThis.URL })).join("\n"));
