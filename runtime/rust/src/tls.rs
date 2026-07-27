//! Bounded-buffer Rustls client primitives. Every input/output pointer is borrowed
//! only for one call; persistent state owns only Rustls objects.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use std::io::{self, Cursor, Read, Write};
use std::sync::Arc;

pub const MAL_TLS_STATUS_OK: i32 = 0;
pub const MAL_TLS_STATUS_INVALID_ARGUMENT: i32 = -1;
pub const MAL_TLS_STATUS_ERROR: i32 = -2;

#[derive(Debug)]
struct NoCertificateVerification;

impl ServerCertVerifier for NoCertificateVerification {
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
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

pub struct MalTlsClient {
    connection: ClientConnection,
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
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let Ok(builder) =
        ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()
    else {
        return MAL_TLS_STATUS_ERROR;
    };
    let mut config = if insecure != 0 {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_no_client_auth()
    } else {
        let Some(ca_pem) = (unsafe { input(ca_pem, ca_pem_len) }) else {
            return MAL_TLS_STATUS_INVALID_ARGUMENT;
        };
        let mut roots = RootCertStore::empty();
        let mut pem = Cursor::new(ca_pem);
        let certificates = rustls_pemfile::certs(&mut pem);
        let mut added = 0;
        for certificate in certificates {
            let Ok(certificate) = certificate else {
                return MAL_TLS_STATUS_INVALID_ARGUMENT;
            };
            if roots.add(certificate).is_ok() {
                added += 1;
            }
        }
        if added == 0 {
            return MAL_TLS_STATUS_INVALID_ARGUMENT;
        }
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    let Some(alpn) = (unsafe { input(alpn, alpn_len) }) else {
        return MAL_TLS_STATUS_INVALID_ARGUMENT;
    };
    if !alpn.is_empty() {
        config.alpn_protocols.push(alpn.to_vec());
    }
    let Ok(connection) = ClientConnection::new(Arc::new(config), server_name) else {
        return MAL_TLS_STATUS_ERROR;
    };
    unsafe { *out_handle = Box::into_raw(Box::new(MalTlsClient { connection })) };
    MAL_TLS_STATUS_OK
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
    let mut cursor = Cursor::new(input);
    if client.connection.read_tls(&mut cursor).is_err() {
        return MAL_TLS_STATUS_ERROR;
    }
    unsafe { *consumed = cursor.position() as usize };
    if client.connection.process_new_packets().is_err() {
        return MAL_TLS_STATUS_ERROR;
    }
    MAL_TLS_STATUS_OK
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
