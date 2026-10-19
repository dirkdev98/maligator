import {
	BroadcastChannel,
	getEnvironmentData,
	setEnvironmentData,
} from "node:worker_threads";

const channel = new BroadcastChannel("local");
channel.onmessage = (event) => {
	if (event.data !== "from main") return;
	channel.postMessage("worker got from main");
	channel.close();
};
setEnvironmentData("worker", true);
const environment = {
	shared: getEnvironmentData("shared")?.count,
	gone: getEnvironmentData("gone") !== undefined,
	late: getEnvironmentData("late") !== undefined,
};
channel.postMessage(`env ${JSON.stringify(environment)}`);
channel.postMessage("worker ready");
