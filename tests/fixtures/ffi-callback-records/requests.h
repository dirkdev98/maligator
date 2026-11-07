#ifndef REQUESTS_H
#define REQUESTS_H

#define REQUEST_DEFERRED 2

typedef void (*RequestCallback)(int status, const char *message, void *userdata);
typedef struct {
	RequestCallback callback;
	void *userdata;
	int mode;
} RequestCallbackInfo;

typedef void (*DoneCallback)(int value, void *userdata);

typedef struct {
	int (*visit)(int value, void *userdata);
	void *userdata;
} Visitor;

int request_device(RequestCallbackInfo info);
void request_value(int value, DoneCallback done, void *userdata);
void process_events(void);
int pending_requests(void);
int visit_values(int count, Visitor visitor);
int request_threaded(int value, DoneCallback done, void *userdata);

#endif
