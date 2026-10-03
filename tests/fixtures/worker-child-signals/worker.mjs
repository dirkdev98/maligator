import { parentPort } from "maligator:workers";
import { childSignalOutcomes } from "./outcomes.mjs";

parentPort.postMessage(await childSignalOutcomes());
