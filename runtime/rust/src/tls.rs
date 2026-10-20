//! Bounded-buffer Rustls session primitives for both roles. Every input/output
//! pointer is borrowed only for one call; persistent state owns only Rustls objects.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{Accepted, Acceptor, ResolvesServerCert, WebPkiClientVerifier};
use rustls::sign::CertifiedKey;
use rustls::{
    ClientConfig, ClientConnection, Connection, DigitallySignedStruct, ProtocolVersion,
    RootCertStore, ServerConfig, ServerConnection, SignatureScheme,
};
use crate::x509::describe_certificate;
use std::collections::VecDeque;
use std::io::{self, Cursor, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const MAL_TLS_STATUS_OK: i32 = 0;
pub const MAL_TLS_STATUS_INVALID_ARGUMENT: i32 = -1;
pub const MAL_TLS_STATUS_ERROR: i32 = -2;
pub const MAL_TLS_STATUS_BAD_CERT: i32 = -3;
pub const MAL_TLS_STATUS_BAD_KEY: i32 = -4;
pub const MAL_TLS_STATUS_KEY_MISMATCH: i32 = -5;
pub const MAL_TLS_STATUS_BAD_CA: i32 = -6;

pub const MAL_TLS_INFO_ALPN: i32 = 0;
pub const MAL_TLS_INFO_PROTOCOL: i32 = 1;
pub const MAL_TLS_INFO_CIPHER: i32 = 2;
pub const MAL_TLS_INFO_SERVER_NAME: i32 = 3;
pub const MAL_TLS_INFO_PEER_CERTIFIED: i32 = 4;
pub const MAL_TLS_INFO_FAILURE: i32 = 5;
pub const MAL_TLS_INFO_AUTHORIZATION_ERROR: i32 = 6;

/// `rejectUnauthorized: false`: the handshake still proves possession of the certificate's key,
/// while `authorized`/`authorizationError` ask the wrapped verifier afterwards, as Node does.
#[derive(Debug)]
struct DeferredServerVerifier {
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for DeferredServerVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, certificate, signature, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, certificate, signature, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

type ServerVerdict = (Option<Arc<rustls::client::WebPkiServerVerifier>>, ServerName<'static>);

fn self_signed(certificate: &[u8]) -> bool {
    crate::x509::self_issued(certificate)
}

// OpenSSL's X509_verify_cert_error_string codes, which Node reports as authorizationError.
fn verify_code(error: &rustls::Error, chain: &[CertificateDer<'_>]) -> &'static str {
    use rustls::CertificateError as E;
    let rustls::Error::InvalidCertificate(error) = error else {
        return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    };
    match error {
        E::UnknownIssuer => match chain {
            [leaf] if self_signed(leaf) => "DEPTH_ZERO_SELF_SIGNED_CERT",
            [_] => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            [.., root] if self_signed(root) => "SELF_SIGNED_CERT_IN_CHAIN",
            _ => "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        },
        E::Expired | E::ExpiredContext { .. } => "CERT_HAS_EXPIRED",
        E::NotValidYet | E::NotValidYetContext { .. } => "CERT_NOT_YET_VALID",
        E::NotValidForName | E::NotValidForNameContext { .. } => "ERR_TLS_CERT_ALTNAME_INVALID",
        E::BadSignature => "CERT_SIGNATURE_FAILURE",
        E::Revoked => "CERT_REVOKED",
        E::InvalidPurpose | E::InvalidPurposeContext { .. } => "INVALID_PURPOSE",
        _ => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }
}

pub struct MalTlsClient {
    connection: Connection,
    /// OpenSSL's reason text for the failure that ended the session, when one corresponds.
    failure: Option<&'static str>,
    /// Judges a client certificate the handshake admitted without verifying it.
    client_verifier: Option<Arc<dyn ClientCertVerifier>>,
    /// Judges a server certificate under `rejectUnauthorized: false`.
    server_verdict: Option<ServerVerdict>,
    seen_ciphertext: bool,
    peer_closed: bool,
    config_id: u64,
    record_header: [u8; 5],
    record_header_length: usize,
    record_remaining: usize,
}

impl MalTlsClient {
    /// The OpenSSL verify code for an admitted but unverified peer, or None once it verifies.
    fn authorization_error(&self) -> Option<&'static str> {
        let chain = self.connection.peer_certificates().unwrap_or(&[]);
        if let Some(verifier) = &self.client_verifier {
            // Node reports a requested but absent client certificate this way.
            let Some((leaf, intermediates)) = chain.split_first() else {
                return Some("UNABLE_TO_GET_ISSUER_CERT");
            };
            return verifier
                .verify_client_cert(leaf, intermediates, UnixTime::now())
                .err()
                .map(|error| verify_code(&error, chain));
        }
        if let Some((verifier, name)) = &self.server_verdict {
            let (leaf, intermediates) = chain.split_first()?;
            let Some(verifier) = verifier else {
                return Some(verify_code(&rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer), chain));
            };
            return verifier
                .verify_server_cert(leaf, intermediates, name, &[], UnixTime::now())
                .err()
                .map(|error| verify_code(&error, chain));
        }
        None
    }

    fn consumed_ciphertext(&mut self, mut bytes: &[u8]) {
        // Rustls may retain a partial record after consuming every byte in the C staging buffer.
        while !bytes.is_empty() {
            if self.record_remaining > 0 {
                let length = self.record_remaining.min(bytes.len());
                self.record_remaining -= length;
                bytes = &bytes[length..];
            } else {
                let length = (5 - self.record_header_length).min(bytes.len());
                self.record_header[self.record_header_length..self.record_header_length + length]
                    .copy_from_slice(&bytes[..length]);
                self.record_header_length += length;
                bytes = &bytes[length..];
                if self.record_header_length == 5 {
                    self.record_remaining =
                        u16::from_be_bytes([self.record_header[3], self.record_header[4]]) as usize;
                    self.record_header_length = 0;
                }
            }
        }
    }
}

struct CachedConfig {
    ca_pem: Vec<u8>,
    alpn: Vec<u8>,
    cert_pem: Vec<u8>,
    key_pem: Vec<u8>,
    insecure: bool,
    policy: ClientPolicy,
}

impl CachedConfig {
    fn matches(&self, ca_pem: &[u8], alpn: &[u8], cert_pem: &[u8], key_pem: &[u8], insecure: bool) -> bool {
        self.insecure == insecure
            && self.ca_pem == ca_pem
            && self.alpn == alpn
            && self.cert_pem == cert_pem
            && self.key_pem == key_pem
    }
}

#[derive(Clone)]
struct ClientPolicy {
    config: Arc<ClientConfig>,
    /// Zero for `rejectUnauthorized: false`, whose connections are never pooled.
    id: u64,
    deferred: Option<Option<Arc<rustls::client::WebPkiServerVerifier>>>,
}

type ClientIdentity = (Vec<CertificateDer<'static>>, rustls::pki_types::PrivateKeyDer<'static>);

// Node presents a client certificate only when both halves are configured.
fn client_identity(cert_pem: &[u8], key_pem: &[u8]) -> Result<Option<ClientIdentity>, i32> {
    if cert_pem.is_empty() || key_pem.is_empty() {
        return Ok(None);
    }
    let mut chain = Vec::new();
    for certificate in CertificateDer::pem_slice_iter(cert_pem) {
        chain.push(certificate.map_err(|_| MAL_TLS_STATUS_BAD_CERT)?);
    }
    if chain.is_empty() {
        return Err(MAL_TLS_STATUS_BAD_CERT);
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem).map_err(|_| MAL_TLS_STATUS_BAD_KEY)?;
    Ok(Some((chain, key)))
}

static CONFIGS: OnceLock<Mutex<VecDeque<CachedConfig>>> = OnceLock::new();
static NEXT_CONFIG_ID: AtomicU64 = AtomicU64::new(1);

fn client_config(
    ca_pem: &[u8],
    alpn: &[u8],
    cert_pem: &[u8],
    key_pem: &[u8],
    insecure: bool,
) -> Result<ClientPolicy, i32> {
    let cache = CONFIGS.get_or_init(|| Mutex::new(VecDeque::new()));
    {
        let entries = cache.lock().map_err(|_| MAL_TLS_STATUS_ERROR)?;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.matches(ca_pem, alpn, cert_pem, key_pem, insecure))
        {
            return Ok(entry.policy.clone());
        }
    }
    let identity = client_identity(cert_pem, key_pem)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    let mut added = 0;
    for certificate in CertificateDer::pem_slice_iter(ca_pem) {
        let certificate = certificate.map_err(|_| MAL_TLS_STATUS_INVALID_ARGUMENT)?;
        if roots.add(certificate).is_ok() {
            added += 1;
        }
    }
    if added == 0 && !insecure {
        return Err(MAL_TLS_STATUS_INVALID_ARGUMENT);
    }
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| MAL_TLS_STATUS_ERROR)?;
    let (builder, deferred) = if insecure {
        let verifier = (added > 0)
            .then(|| {
                rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
                    .build()
                    .ok()
            })
            .flatten();
        let deferred = Arc::new(DeferredServerVerifier {
            algorithms: provider.signature_verification_algorithms,
        });
        (builder.dangerous().with_custom_certificate_verifier(deferred), Some(verifier))
    } else {
        (builder.with_root_certificates(roots), None)
    };
    let mut config = match identity {
        Some((chain, key)) => builder
            .with_client_auth_cert(chain, key)
            .map_err(|_| MAL_TLS_STATUS_KEY_MISMATCH)?,
        None => builder.with_no_client_auth(),
    };
    if !alpn.is_empty() {
        config.alpn_protocols.push(alpn.to_vec());
    }
    let id = if insecure {
        0
    } else {
        NEXT_CONFIG_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| MAL_TLS_STATUS_ERROR)?
    };
    let policy = ClientPolicy { config: Arc::new(config), id, deferred };
    // Exact trust bytes prevent a changed CA file from borrowing an older connection policy.
    if ca_pem.len() <= 1024 * 1024 && alpn.len() <= 255 && cert_pem.len() + key_pem.len() <= 64 * 1024 {
        let mut entries = cache.lock().map_err(|_| MAL_TLS_STATUS_ERROR)?;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.matches(ca_pem, alpn, cert_pem, key_pem, insecure))
        {
            return Ok(entry.policy.clone());
        }
        if entries.len() == 4 {
            entries.pop_front();
        }
        entries.push_back(CachedConfig {
            ca_pem: ca_pem.to_vec(),
            alpn: alpn.to_vec(),
            cert_pem: cert_pem.to_vec(),
            key_pem: key_pem.to_vec(),
            insecure,
            policy: policy.clone(),
        });
    }
    Ok(policy)
}

struct BoundedWriter<'a> {
    output: &'a mut [u8],
    produced: usize,
}

impl Write for BoundedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let available = self.output.len().saturating_sub(self.produced);
        if available == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let selected = available.min(bytes.len());
        self.output[self.produced..self.produced + selected].copy_from_slice(&bytes[..selected]);
        self.produced += selected;
        Ok(selected)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

unsafe fn input<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if length == 0 {
        Some(&[])
    } else if pointer.is_null() || length > isize::MAX as usize {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts(pointer, length) })
    }
}

unsafe fn output<'a>(pointer: *mut u8, length: usize) -> Option<&'a mut [u8]> {
    if length == 0 {
        Some(&mut [])
    } else if pointer.is_null() || length > isize::MAX as usize {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(pointer, length) })
    }
}

#[no_mangle]
/// # Safety
/// Every non-null pointer must be valid for its stated length or output slot.
pub unsafe extern "C" fn mal_tls_client_create(
    server_name: *const u8,
    server_name_len: usize,
    ca_pem: *const u8,
    ca_pem_len: usize,
    alpn: *const u8,
    alpn_len: usize,
    cert_pem: *const u8,
    cert_pem_len: usize,
    key_pem: *const u8,
    key_pem_len: usize,
    insecure: i32,
    out_handle: *mut *mut MalTlsClient,
) -> i32 {
    if out_handle.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *out_handle = core::ptr::null_mut() };
    let Some(server_name) = (unsafe { input(server_name, server_name_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let Ok(server_name) = core::str::from_utf8(server_name) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let Ok(server_name) = ServerName::try_from(server_name.to_owned()) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let Some(ca_pem) = (unsafe { input(ca_pem, ca_pem_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let Some(alpn) = (unsafe { input(alpn, alpn_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let (Some(cert_pem), Some(key_pem)) =
        (unsafe { (input(cert_pem, cert_pem_len), input(key_pem, key_pem_len)) })
    else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let policy = match client_config(ca_pem, alpn, cert_pem, key_pem, insecure != 0) {
        Ok(policy) => policy,
        Err(status) => return status,
    };
    let Ok(connection) = ClientConnection::new(policy.config, server_name.clone()) else {
        return MAL_TLS_STATUS_ERROR;
    };
    let session = new_session(Connection::Client(connection), policy.id, None);
    unsafe {
        (*session).server_verdict = policy.deferred.map(|verifier| (verifier, server_name));
        *out_handle = session;
    }
    MAL_TLS_STATUS_OK
}

fn new_session(
    connection: Connection,
    config_id: u64,
    client_verifier: Option<Arc<dyn ClientCertVerifier>>,
) -> *mut MalTlsClient {
    Box::into_raw(Box::new(MalTlsClient {
        connection,
        failure: None,
        client_verifier,
        server_verdict: None,
        seen_ciphertext: false,
        peer_closed: false,
        config_id,
        record_header: [0; 5],
        record_header_length: 0,
        record_remaining: 0,
    }))
}

pub struct MalTlsServerConfig {
    config: Arc<ServerConfig>,
    client_verifier: Option<Arc<dyn ClientCertVerifier>>,
}

/// Node's `rejectUnauthorized: false` with `requestCert`: any client certificate completes the
/// handshake, and `authorized` asks the wrapped verifier afterwards.
#[derive(Debug)]
struct DeferredClientVerifier(Arc<dyn ClientCertVerifier>);

impl ClientCertVerifier for DeferredClientVerifier {
    fn client_auth_mandatory(&self) -> bool {
        false
    }

    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        self.0.root_hint_subjects()
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

#[derive(Debug)]
struct NoServerCertificate;

// Node accepts a context without credentials and fails each handshake instead.
impl ResolvesServerCert for NoServerCertificate {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        None
    }
}

fn server_config(
    cert_pem: &[u8],
    key_pem: &[u8],
    ca_pem: &[u8],
    alpn_wire: &[u8],
    request_cert: bool,
    reject_unauthorized: bool,
) -> Result<(ServerConfig, Option<Arc<dyn ClientCertVerifier>>), i32> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut deferred = None;
    let builder = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| MAL_TLS_STATUS_ERROR)?;
    let builder = if request_cert && !ca_pem.is_empty() {
        let mut roots = RootCertStore::empty();
        for certificate in CertificateDer::pem_slice_iter(ca_pem) {
            let certificate = certificate.map_err(|_| MAL_TLS_STATUS_BAD_CA)?;
            roots.add(certificate).map_err(|_| MAL_TLS_STATUS_BAD_CA)?;
        }
        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
            .build()
            .map_err(|_| MAL_TLS_STATUS_BAD_CA)?;
        if reject_unauthorized {
            builder.with_client_cert_verifier(verifier)
        } else {
            deferred = Some(verifier.clone());
            builder.with_client_cert_verifier(Arc::new(DeferredClientVerifier(verifier)))
        }
    } else {
        builder.with_no_client_auth()
    };
    let mut chain = Vec::new();
    if !cert_pem.is_empty() {
        for certificate in CertificateDer::pem_slice_iter(cert_pem) {
            chain.push(certificate.map_err(|_| MAL_TLS_STATUS_BAD_CERT)?);
        }
        if chain.is_empty() {
            return Err(MAL_TLS_STATUS_BAD_CERT);
        }
    }
    let key = if key_pem.is_empty() {
        None
    } else {
        Some(PrivateKeyDer::from_pem_slice(key_pem).map_err(|_| MAL_TLS_STATUS_BAD_KEY)?)
    };
    let mut config = match key {
        Some(key) if !chain.is_empty() => builder
            .with_single_cert(chain, key)
            .map_err(|_| MAL_TLS_STATUS_KEY_MISMATCH)?,
        _ => builder.with_cert_resolver(Arc::new(NoServerCertificate)),
    };
    let mut wire = alpn_wire;
    while let Some((&length, rest)) = wire.split_first() {
        let length = length as usize;
        if length == 0 || length > rest.len() {
            return Err(MAL_TLS_STATUS_INVALID_ARGUMENT);
        }
        config.alpn_protocols.push(rest[..length].to_vec());
        wire = &rest[length..];
    }
    Ok((config, deferred))
}

#[no_mangle]
/// # Safety
/// Every non-null pointer must be valid for its stated length or output slot.
pub unsafe extern "C" fn mal_tls_server_config_create(
    cert_pem: *const u8,
    cert_pem_len: usize,
    key_pem: *const u8,
    key_pem_len: usize,
    ca_pem: *const u8,
    ca_pem_len: usize,
    alpn_wire: *const u8,
    alpn_wire_len: usize,
    request_cert: i32,
    reject_unauthorized: i32,
    out_config: *mut *mut MalTlsServerConfig,
) -> i32 {
    if out_config.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *out_config = core::ptr::null_mut() };
    let (Some(cert), Some(key), Some(ca), Some(alpn)) = (unsafe {
        (
            input(cert_pem, cert_pem_len),
            input(key_pem, key_pem_len),
            input(ca_pem, ca_pem_len),
            input(alpn_wire, alpn_wire_len),
        )
    }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    match server_config(
        cert,
        key,
        ca,
        alpn,
        request_cert != 0,
        reject_unauthorized != 0,
    ) {
        Ok((config, client_verifier)) => {
            unsafe {
                *out_config = Box::into_raw(Box::new(MalTlsServerConfig {
                    config: Arc::new(config),
                    client_verifier,
                }))
            };
            MAL_TLS_STATUS_OK
        }
        Err(status) => status,
    }
}

#[no_mangle]
/// # Safety
/// `config` must be null or a valid slot holding a live or null configuration.
pub unsafe extern "C" fn mal_tls_server_config_free(config: *mut *mut MalTlsServerConfig) {
    if config.is_null() {
        return;
    }
    let pointer = unsafe { *config };
    unsafe { *config = core::ptr::null_mut() };
    if !pointer.is_null() {
        drop(unsafe { Box::from_raw(pointer) });
    }
}

#[no_mangle]
/// # Safety
/// `config` must point to a live configuration and `out_handle` to a writable slot.
pub unsafe extern "C" fn mal_tls_server_create(
    config: *const MalTlsServerConfig,
    out_handle: *mut *mut MalTlsClient,
) -> i32 {
    if config.is_null() || out_handle.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *out_handle = core::ptr::null_mut() };
    let config = unsafe { &*config };
    let Ok(connection) = ServerConnection::new(config.config.clone()) else {
        return MAL_TLS_STATUS_ERROR;
    };
    unsafe { *out_handle = new_session(Connection::Server(connection), 0, config.client_verifier.clone()) };
    MAL_TLS_STATUS_OK
}

/// Reads a ClientHello before any configuration is chosen, so `SNICallback` can pick one.
pub struct MalTlsAcceptor {
    acceptor: Acceptor,
    accepted: Option<Accepted>,
}

#[no_mangle]
/// # Safety
/// `out` must be a writable slot.
pub unsafe extern "C" fn mal_tls_acceptor_create(out: *mut *mut MalTlsAcceptor) -> i32 {
    if out.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    let acceptor = MalTlsAcceptor { acceptor: Acceptor::default(), accepted: None };
    unsafe { *out = Box::into_raw(Box::new(acceptor)) };
    MAL_TLS_STATUS_OK
}

#[no_mangle]
/// # Safety
/// `handle` must be live and `input` valid for `input_len` bytes.
pub unsafe extern "C" fn mal_tls_acceptor_read(
    handle: *mut MalTlsAcceptor,
    input_pointer: *const u8,
    input_len: usize,
) -> i32 {
    let (Some(handle), Some(mut bytes)) = (unsafe { handle.as_mut() }, unsafe { input(input_pointer, input_len) })
    else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    if handle.accepted.is_some() {
        return MAL_TLS_STATUS_ERROR;
    }
    while !bytes.is_empty() {
        match handle.acceptor.read_tls(&mut bytes) {
            Ok(0) | Err(_) => return MAL_TLS_STATUS_ERROR,
            Ok(_) => {}
        }
        match handle.acceptor.accept() {
            Ok(None) => {}
            Ok(Some(accepted)) => {
                // Bytes after the ClientHello belong to the session, which a ClientHello flight never has.
                if !bytes.is_empty() {
                    return MAL_TLS_STATUS_ERROR;
                }
                handle.accepted = Some(accepted);
            }
            Err(_) => return MAL_TLS_STATUS_ERROR,
        }
    }
    MAL_TLS_STATUS_OK
}

#[no_mangle]
/// # Safety
/// `handle` must be live; `output` is valid for `output_len` bytes. Returns the server
/// name's length, -1 when the ClientHello carried none, or -2 before it is complete.
pub unsafe extern "C" fn mal_tls_acceptor_server_name(
    handle: *const MalTlsAcceptor,
    output_pointer: *mut u8,
    output_len: usize,
) -> isize {
    let Some(handle) = (unsafe { handle.as_ref() }) else {
        return -2;
    };
    let Some(accepted) = &handle.accepted else {
        return -2;
    };
    let hello = accepted.client_hello();
    let Some(name) = hello.server_name() else {
        return -1;
    };
    let Some(output) = (unsafe { output(output_pointer, output_len) }) else {
        return -2;
    };
    let length = name.len().min(output.len());
    output[..length].copy_from_slice(&name.as_bytes()[..length]);
    name.len() as isize
}

#[no_mangle]
/// # Safety
/// `handle` must be live, `config` a live configuration, and `out_handle` writable.
pub unsafe extern "C" fn mal_tls_acceptor_accept(
    handle: *mut MalTlsAcceptor,
    config: *const MalTlsServerConfig,
    out_handle: *mut *mut MalTlsClient,
) -> i32 {
    let (Some(handle), Some(config)) = (unsafe { handle.as_mut() }, unsafe { config.as_ref() }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    if out_handle.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *out_handle = core::ptr::null_mut() };
    let Some(accepted) = handle.accepted.take() else {
        return MAL_TLS_STATUS_ERROR;
    };
    match accepted.into_connection(config.config.clone()) {
        Ok(connection) => {
            unsafe {
                *out_handle =
                    new_session(Connection::Server(connection), 0, config.client_verifier.clone())
            };
            MAL_TLS_STATUS_OK
        }
        Err(_) => MAL_TLS_STATUS_ERROR,
    }
}

#[no_mangle]
/// # Safety
/// `handle` must be null or a valid slot holding a live or null acceptor.
pub unsafe extern "C" fn mal_tls_acceptor_free(handle: *mut *mut MalTlsAcceptor) {
    if handle.is_null() {
        return;
    }
    let pointer = unsafe { *handle };
    unsafe { *handle = core::ptr::null_mut() };
    if !pointer.is_null() {
        drop(unsafe { Box::from_raw(pointer) });
    }
}

#[no_mangle]
/// # Safety
/// `handle` must be live; `output` is valid for `output_len` bytes. Returns the
/// value length, or -1 when the session has no such value yet.
pub unsafe extern "C" fn mal_tls_session_info(
    handle: *const MalTlsClient,
    kind: i32,
    output_pointer: *mut u8,
    output_len: usize,
) -> isize {
    if handle.is_null() {
        return -1;
    }
    let connection = &unsafe { &*handle }.connection;
    let owned: String;
    let value: &[u8] = match kind {
        MAL_TLS_INFO_ALPN => match connection.alpn_protocol() {
            Some(alpn) => alpn,
            None => return -1,
        },
        MAL_TLS_INFO_PROTOCOL => match connection.protocol_version() {
            Some(ProtocolVersion::TLSv1_3) => b"TLSv1.3",
            Some(ProtocolVersion::TLSv1_2) => b"TLSv1.2",
            _ => return -1,
        },
        MAL_TLS_INFO_CIPHER => match connection
            .negotiated_cipher_suite()
            .and_then(|suite| suite.suite().as_str())
        {
            // OpenSSL names TLS 1.3 suites by their IANA names, which Rustls prefixes.
            Some(name) => {
                owned = name.replacen("TLS13_", "TLS_", 1);
                owned.as_bytes()
            }
            None => return -1,
        },
        MAL_TLS_INFO_SERVER_NAME => match connection {
            Connection::Server(server) => match server.server_name() {
                Some(name) => name.as_bytes(),
                None => return -1,
            },
            Connection::Client(_) => return -1,
        },
        MAL_TLS_INFO_FAILURE => match unsafe { &*handle }.failure {
            Some(reason) => reason.as_bytes(),
            None => return -1,
        },
        MAL_TLS_INFO_PEER_CERTIFIED => match unsafe { &*handle }.authorization_error() {
            None if connection.peer_certificates().is_some_and(|chain| !chain.is_empty()) => b"1",
            _ => return -1,
        },
        MAL_TLS_INFO_AUTHORIZATION_ERROR => match unsafe { &*handle }.authorization_error() {
            Some(code) => code.as_bytes(),
            None => return -1,
        },
        _ => return -1,
    };
    let Some(output) = (unsafe { output(output_pointer, output_len) }) else {
        return -1;
    };
    let length = value.len().min(output.len());
    output[..length].copy_from_slice(&value[..length]);
    value.len() as isize
}

#[no_mangle]
/// # Safety
/// A non-null handle must remain valid for the duration of the call.
pub unsafe extern "C" fn mal_tls_client_config_id(handle: *const MalTlsClient) -> u64 {
    if handle.is_null() {
        0
    } else {
        unsafe { (*handle).config_id }
    }
}

#[no_mangle]
/// # Safety
/// A non-null handle must remain valid for the duration of the call.
pub unsafe extern "C" fn mal_tls_client_has_pending_input(handle: *const MalTlsClient) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let client = unsafe { &*handle };
    i32::from(client.record_header_length != 0 || client.record_remaining != 0)
}

#[no_mangle]
/// # Safety
/// `handle` and `consumed` must be valid and uniquely borrowed; input is valid
/// for `input_len` bytes and must not overlap either output.
pub unsafe extern "C" fn mal_tls_client_read_ciphertext(
    handle: *mut MalTlsClient,
    input_pointer: *const u8,
    input_len: usize,
    consumed: *mut usize,
) -> i32 {
    if handle.is_null() || consumed.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *consumed = 0 };
    let Some(input) = (unsafe { input(input_pointer, input_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let client = unsafe { &mut *handle };
    let first = !client.seen_ciphertext && !input.is_empty();
    client.seen_ciphertext |= !input.is_empty();
    let mut cursor = Cursor::new(input);
    if client.connection.read_tls(&mut cursor).is_err() {
        return MAL_TLS_STATUS_ERROR;
    }
    client.consumed_ciphertext(&input[..cursor.position() as usize]);
    unsafe { *consumed = cursor.position() as usize };
    match client.connection.process_new_packets() {
        Ok(state) => client.peer_closed = state.peer_has_closed(),
        Err(error) => {
            client.failure = failure_reason(&error, first.then_some(input));
            return MAL_TLS_STATUS_ERROR;
        }
    }
    MAL_TLS_STATUS_OK
}

// OpenSSL's reason strings, which Node turns into `ERR_SSL_*` codes, for the failures
// whose cause rustls reports unambiguously.
fn failure_reason(error: &rustls::Error, first_input: Option<&[u8]>) -> Option<&'static str> {
    use rustls::{AlertDescription, Error, InvalidMessage};
    match error {
        // tls_validate_record_header recognizes exactly these four request prefixes.
        Error::InvalidMessage(InvalidMessage::InvalidContentType) => first_input
            .filter(|bytes| {
                [b"GET ", b"POST", b"HEAD", b"PUT "]
                    .iter()
                    .any(|prefix| bytes.starts_with(*prefix))
            })
            .map(|_| "http request"),
        Error::AlertReceived(AlertDescription::UnknownCA) => Some("tlsv1 alert unknown ca"),
        Error::NoCertificatesPresented => Some("peer did not return a certificate"),
        _ => None,
    }
}

#[no_mangle]
/// # Safety
/// `handle` and `consumed` must be valid and uniquely borrowed; input is valid
/// for `input_len` bytes and must not overlap either output.
pub unsafe extern "C" fn mal_tls_client_write_plaintext(
    handle: *mut MalTlsClient,
    input_pointer: *const u8,
    input_len: usize,
    consumed: *mut usize,
) -> i32 {
    if handle.is_null() || consumed.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *consumed = 0 };
    let Some(input) = (unsafe { input(input_pointer, input_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    match unsafe { &mut *handle }.connection.writer().write(input) {
        Ok(count) => {
            unsafe { *consumed = count };
            MAL_TLS_STATUS_OK
        }
        Err(_) => MAL_TLS_STATUS_ERROR,
    }
}

#[no_mangle]
/// # Safety
/// `handle` and `produced` must be valid and uniquely borrowed; output is valid
/// for `output_len` bytes and must not overlap either pointer.
pub unsafe extern "C" fn mal_tls_client_read_plaintext(
    handle: *mut MalTlsClient,
    output_pointer: *mut u8,
    output_len: usize,
    produced: *mut usize,
) -> i32 {
    if handle.is_null() || produced.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *produced = 0 };
    let Some(output) = (unsafe { output(output_pointer, output_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    match unsafe { &mut *handle }.connection.reader().read(output) {
        Ok(count) => {
            unsafe { *produced = count };
            MAL_TLS_STATUS_OK
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => MAL_TLS_STATUS_OK,
        Err(_) => MAL_TLS_STATUS_ERROR,
    }
}

#[no_mangle]
/// # Safety
/// `handle` and `produced` must be valid and uniquely borrowed; output is valid
/// for `output_len` bytes and must not overlap either pointer.
pub unsafe extern "C" fn mal_tls_client_write_ciphertext(
    handle: *mut MalTlsClient,
    output_pointer: *mut u8,
    output_len: usize,
    produced: *mut usize,
) -> i32 {
    if handle.is_null() || produced.is_null() {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    }
    unsafe { *produced = 0 };
    let Some(output) = (unsafe { output(output_pointer, output_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    let mut writer = BoundedWriter {
        output,
        produced: 0,
    };
    match unsafe { &mut *handle }.connection.write_tls(&mut writer) {
        Ok(_) => {
            unsafe { *produced = writer.produced };
            MAL_TLS_STATUS_OK
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            unsafe { *produced = writer.produced };
            MAL_TLS_STATUS_OK
        }
        Err(_) => MAL_TLS_STATUS_ERROR,
    }
}

#[no_mangle]
/// # Safety
/// `handle` is null or a live TLS client handle borrowed for this call.
pub unsafe extern "C" fn mal_tls_client_peer_closed(handle: *const MalTlsClient) -> i32 {
    if handle.is_null() {
        return 0;
    }
    i32::from(unsafe { &*handle }.peer_closed)
}

#[no_mangle]
/// # Safety
/// A non-null handle must point to a live `MalTlsClient`.
pub unsafe extern "C" fn mal_tls_client_is_handshaking(handle: *const MalTlsClient) -> i32 {
    if handle.is_null() {
        -1
    } else {
        unsafe { &*handle }.connection.is_handshaking() as i32
    }
}

#[no_mangle]
/// # Safety
/// A non-null handle must point to a live `MalTlsClient`.
pub unsafe extern "C" fn mal_tls_client_wants_write(handle: *const MalTlsClient) -> i32 {
    if handle.is_null() {
        -1
    } else {
        unsafe { &*handle }.connection.wants_write() as i32
    }
}

#[no_mangle]
/// # Safety
/// `handle` must be null or a valid writable slot containing a pointer returned by
/// `mal_tls_client_create` that has not already been freed.
pub unsafe extern "C" fn mal_tls_client_free(handle: *mut *mut MalTlsClient) {
    if handle.is_null() {
        return;
    }
    let pointer = unsafe { *handle };
    unsafe { *handle = core::ptr::null_mut() };
    if !pointer.is_null() {
        drop(unsafe { Box::from_raw(pointer) });
    }
}

#[no_mangle]
/// # Safety
/// `handle` must be live; `output` is valid for `output_len` bytes. Returns the
/// leaf peer certificate's DER length, or -1 without one.
pub unsafe extern "C" fn mal_tls_session_peer_certificate(
    handle: *const MalTlsClient,
    output_pointer: *mut u8,
    output_len: usize,
) -> isize {
    let Some(handle) = (unsafe { handle.as_ref() }) else {
        return -1;
    };
    let Some(certificate) = handle.connection.peer_certificates().and_then(|chain| chain.first()) else {
        return -1;
    };
    if let Some(output) = unsafe { output(output_pointer, output_len) } {
        let length = certificate.len().min(output.len());
        output[..length].copy_from_slice(&certificate[..length]);
    }
    certificate.len() as isize
}

#[no_mangle]
/// # Safety
/// `der` is valid for `der_len` bytes and `output` for `output_len`. Returns the full
/// record length (see `describe_certificate`), or -1 for malformed DER.
pub unsafe extern "C" fn mal_tls_x509_describe(
    der_pointer: *const u8,
    der_len: usize,
    output_pointer: *mut u8,
    output_len: usize,
) -> isize {
    let Some(certificate) = (unsafe { input(der_pointer, der_len) }) else {
        return -1;
    };
    let Some(records) = describe_certificate(certificate) else {
        return -1;
    };
    if let Some(output) = unsafe { output(output_pointer, output_len) } {
        let length = records.len().min(output.len());
        output[..length].copy_from_slice(&records[..length]);
    }
    records.len() as isize
}
