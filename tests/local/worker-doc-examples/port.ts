import { MessageChannel, type MessagePort } from "maligator:workers";

function installResponder(port: MessagePort): void {
	port.onmessage = (event) => port.postMessage("reply:" + String(event.data));
	port.start();
}

const { port1, port2 } = new MessageChannel();
try {
	installResponder(port2);
	const reply = new Promise<unknown>((resolve) => {
		port1.onmessage = (event) => resolve(event.data);
	});
	port1.start();
	port1.postMessage("hello");
	console.log(await reply);
} finally {
	port1.close();
	port2.close();
}
