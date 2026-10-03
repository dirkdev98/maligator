import { MessageChannel, MessagePort } from "maligator:workers";

const channel = new MessageChannel();
try {
	console.log(channel.port1 instanceof MessagePort);
	const received = new Promise<unknown>((resolve) => {
		channel.port2.onmessage = (event) => resolve(event.data);
	});
	channel.port2.start();
	channel.port1.postMessage({ answer: 42 });
	console.log(JSON.stringify(await received));
} finally {
	channel.port1.close();
	channel.port2.close();
}
