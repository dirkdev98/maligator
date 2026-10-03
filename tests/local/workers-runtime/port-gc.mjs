import { MessageChannel } from "maligator:workers";

function abandon() {
	const channel = new MessageChannel();
	globalThis.peer = channel.port2;
	channel.port1.start();
	channel.port1.unref();
	peer.addEventListener(
		"close",
		(event) => {
			if (!event.isTrusted) throw new Error("native close must have Event state");
			peer.close();
			console.log("port-gc PASS");
		},
		{ once: true },
	);
	peer.start();
}
abandon();
