#include "requests.h"

#include <pthread.h>
#include <stddef.h>
#include <stdlib.h>

static RequestCallbackInfo device;
static int device_pending;
static DoneCallback done;
static void *done_userdata;
static int done_value;

int request_device(RequestCallbackInfo info) {
	if (info.mode != REQUEST_DEFERRED || info.callback == NULL) return -1;
	device = info;
	device_pending = 1;
	return 0;
}

void request_value(int value, DoneCallback callback, void *userdata) {
	done = callback;
	done_userdata = userdata;
	done_value = value;
}

void process_events(void) {
	if (device_pending) {
		device_pending = 0;
		device.callback(0, "ready", device.userdata);
	}
	if (done != NULL) {
		DoneCallback callback = done;
		done = NULL;
		callback(done_value, done_userdata);
	}
}

int pending_requests(void) {
	return device_pending + (done != NULL);
}

int visit_values(int count, Visitor visitor) {
	int total = 0;
	for (int value = 0; value < count; value++) total += visitor.visit(value, visitor.userdata);
	return total;
}

typedef struct {
	int value;
	DoneCallback done;
	void *userdata;
} ThreadedRequest;

static void *run_threaded(void *argument) {
	ThreadedRequest *request = argument;
	request->done(request->value, request->userdata);
	free(request);
	return NULL;
}

int request_threaded(int value, DoneCallback callback, void *userdata) {
	ThreadedRequest *request = malloc(sizeof(*request));
	if (request == NULL) return -1;
	*request = (ThreadedRequest) { value, callback, userdata };
	pthread_t thread;
	if (pthread_create(&thread, NULL, run_threaded, request) != 0) {
		free(request);
		return -1;
	}
	pthread_detach(thread);
	return 0;
}
