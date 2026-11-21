import { directory, file, FileSystemError } from "maligator:fs";
import { incrementalScenario } from "./maligator-fs-incremental.mjs";
import { scenario } from "./maligator-fs-scenario.mjs";

const mode = file(".incremental");
if (await mode.exists()) {
	await incrementalScenario(await mode.text());
} else {
	console.log(
		(await scenario({ directory, file, FileSystemError, URL: globalThis.URL })).join(
			"\n",
		),
	);
}
