import { transfer } from "maligator:workers";
import type { TaskContext } from "maligator:workers";

export function reverse(context: TaskContext, buffer: ArrayBuffer) {
	context.throwIfCancelled();
	new Uint8Array(buffer).reverse();
	return transfer(buffer, [buffer]);
}
