#pragma once

#include "vm.h"

void mal_host_install_node_net(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

bool mal_node_net_drain(MalVm *vm);
typedef struct MalTlsClientIdentity MalTlsClientIdentity;
bool mal_node_net_start_tls(
    MalVm *vm, MalValue socket,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure);
/* Rebuilds a listening TLS server's config from its `_sharedCreds`; a server not yet listening
 * reads them at listen. */
bool mal_node_net_server_refresh_tls(MalVm *vm, MalValue server);
typedef struct MalTlsServerConfig MalTlsServerConfig;
/* The most recently added `server._contexts` entry matching `name`, else undefined. */
MalValue mal_node_net_sni_match(MalVm *vm, MalValue server, const byte *name, usize length);
/* A new config from a SecureContext's credentials and `server`'s ALPN and client-cert policy. */
MalTlsServerConfig *mal_node_net_context_config(MalVm *vm, MalValue server, MalValue context);
/* EventEmitter and net.Server option setup for an instance of a net.Server subclass. */
bool mal_node_net_server_init(MalVm *vm, MalValue server, MalValue options, MalValue listener);
/* Undefined until node:net is installed. */
MalValue mal_node_net_server_prototype(void);
typedef struct MalTlsServerConfig MalTlsServerConfig;
/* Builds the config a tls.Server or https.Server stored on itself; `*config` stays
 * null for a plain server. False with a pending exception. */
bool mal_node_net_tls_config(
    MalVm *vm, MalValue server, MalTlsServerConfig **config, bool *without_cert);
