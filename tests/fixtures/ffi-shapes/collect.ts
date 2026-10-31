/* oxlint-disable no-console -- The fixture reports its results on standard output. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { shapes_canvas_open, shapes_canvases_open } from "maligator:ffi/shapes";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

function openWithoutClosing(): void {
	shapes_canvas_open("Dropped");
}

openWithoutClosing();
console.log(`open before collection ${shapes_canvases_open()}`);
collectGarbage();
console.log(`open after collection ${shapes_canvases_open()}`);
