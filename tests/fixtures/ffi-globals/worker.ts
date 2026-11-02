import {
	getMode,
	getThread,
	setThread,
	getThreads,
	setThreads,
	getThreadLabel,
	setThreadLabel,
} from "maligator:ffi/globals";
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = () => {
	const initial = getThread();
	setThread(33);
	const initialArray = getThreads()[0];
	setThreads([35, 36]);
	const initialText = getThreadLabel();
	setThreadLabel("child");
	port.postMessage({
		initial,
		updated: getThread(),
		mode: getMode(),
		initialArray,
		updatedArray: getThreads()[0],
		initialText,
		updatedText: getThreadLabel(),
	});
};
port.start();
