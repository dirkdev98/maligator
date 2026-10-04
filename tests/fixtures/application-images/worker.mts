import { readFileSync } from "node:fs";
import { parentPort } from "maligator:workers";
const generation = "first";
if (parentPort === null) throw new Error("worker requires a parent port");
const port = parentPort;
port.addEventListener("message", () => {
	port.postMessage({
		generation,
		asset: readFileSync(mal.assets.materialize("payload"), "utf8"),
	});
});

port.start();
