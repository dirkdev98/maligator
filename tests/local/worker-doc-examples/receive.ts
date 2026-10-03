import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

const channel = new MessageChannel();
try {
	channel.port1.postMessage("first");
	channel.port1.postMessage("second");
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2));
} finally {
	channel.port1.close();
	channel.port2.close();
}
