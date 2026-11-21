#pragma once

#include "vm.h"

/** Install `maligator:internal/http`, the native layer under `maligator:http`. */
void mal_host_install_maligator_internal_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/** How a `serveAsset` handler maps request paths onto an asset handle. */
typedef struct MalHttpAssetRoute MalHttpAssetRoute;

/** Read `{ prefix, fallback, immutable }`; null after throwing. */
MalHttpAssetRoute *mal_http_asset_route_new(MalVm *vm, MalValue options);
void mal_http_asset_route_free(MalHttpAssetRoute *route);

/** A request header by lowercase name; null when absent. */
typedef const char *(*MalHttpHeaderLookup)(void *context, const char *name, usize *length);

/** The parts of a request an asset reply reads. */
typedef struct MalHttpAssetRequest {
    const char *method;
    usize method_length;
    /** The origin-form target: a path, then any query. */
    const char *target;
    usize target_length;
    MalHttpHeaderLookup header;
    void *context;
} MalHttpAssetRequest;

#define MAL_HTTP_ASSET_REPLY_HEADERS 8

/** A complete response to an asset request. `body` borrows embedded bytes or `owned`. */
typedef struct MalHttpAssetReply {
    int status;
    usize header_count;
    struct {
        const char *name;
        char value[160];
    } headers[MAL_HTTP_ASSET_REPLY_HEADERS];
    const byte *body;
    usize body_length;
    byte *owned;
} MalHttpAssetReply;

/** Answer `request` from `handle` under `route`; false after throwing. */
bool mal_http_asset_reply(
    MalVm *vm,
    const MalHttpAssetRoute *route,
    MalValue handle,
    const MalHttpAssetRequest *request,
    MalHttpAssetReply *reply);

void mal_http_asset_reply_dispose(MalHttpAssetReply *reply);
