import { directory, file, FileSystemError } from "maligator:fs";
import { scenario } from "./maligator-fs-scenario.mjs";

console.log(
	(await scenario({ directory, file, FileSystemError, URL: globalThis.URL })).join("\n"),
);
