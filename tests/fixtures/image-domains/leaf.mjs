import { parentPort } from "maligator:workers";

const generation = "first";
parentPort.addEventListener("message", () => parentPort.postMessage(generation));
parentPort.start();
