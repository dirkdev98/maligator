import { readFileSync } from "node:fs";
import { parentPort } from "maligator:workers";
const generation = "first";
parentPort.addEventListener("message", () => {
	parentPort.postMessage({
		generation,
		asset: readFileSync(mal.assets.materialize("payload"), "utf8"),
	});
});

parentPort.start();
