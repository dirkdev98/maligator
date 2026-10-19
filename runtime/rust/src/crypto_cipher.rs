//! Streaming symmetric ciphers for node:crypto's Cipheriv/Decipheriv.
//!
//! GCM and ChaCha20-Poly1305 are composed from their stream cipher and
//! universal hash so `update` emits output as it goes; only CBC's partial
//! block (and, when decrypting with padding, the last full block) is held back.
//! Pointers are borrowed for one call; no message string crosses the ABI.

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
use aes::{Aes128, Aes192, Aes256};
use chacha20::ChaCha20;
use ghash::GHash;
use poly1305::universal_hash::UniversalHash;
use poly1305::Poly1305;

pub const MAL_CIPHER_OK: i32 = 0;
pub const MAL_CIPHER_INVALID_KEY: i32 = 1;
pub const MAL_CIPHER_INVALID_IV: i32 = 2;
pub const MAL_CIPHER_BAD_DECRYPT: i32 = 3;
pub const MAL_CIPHER_AUTH_FAILED: i32 = 4;
pub const MAL_CIPHER_INVALID_STATE: i32 = 5;
pub const MAL_CIPHER_UNKNOWN: i32 = 6;
pub const MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH: i32 = 7;
pub const MAL_CIPHER_BUFFER_TOO_SMALL: i32 = 8;

enum Block {
    A128(Aes128),
    A192(Aes192),
    A256(Aes256),
}

impl Block {
    fn new(key: &[u8]) -> Option<Block> {
        match key.len() {
            16 => Aes128::new_from_slice(key).ok().map(Block::A128),
            24 => Aes192::new_from_slice(key).ok().map(Block::A192),
            32 => Aes256::new_from_slice(key).ok().map(Block::A256),
            _ => None,
        }
    }

    fn encrypt(&self, block: &mut [u8; 16]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            Block::A128(c) => c.encrypt_block(b),
            Block::A192(c) => c.encrypt_block(b),
            Block::A256(c) => c.encrypt_block(b),
        }
    }

    fn decrypt(&self, block: &mut [u8; 16]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            Block::A128(c) => c.decrypt_block(b),
            Block::A192(c) => c.decrypt_block(b),
            Block::A256(c) => c.decrypt_block(b),
        }
    }
}

type Ctr128<C> = ctr::Ctr128BE<C>;
type Ctr32<C> = ctr::Ctr32BE<C>;

enum Ctr {
    A128(Ctr128<Aes128>),
    A192(Ctr128<Aes192>),
    A256(Ctr128<Aes256>),
    G128(Ctr32<Aes128>),
    G192(Ctr32<Aes192>),
    G256(Ctr32<Aes256>),
}

impl Ctr {
    fn new(key: &[u8], counter: &[u8; 16], gcm: bool) -> Option<Ctr> {
        let iv = GenericArray::from_slice(counter);
        Some(match (key.len(), gcm) {
            (16, false) => Ctr::A128(Ctr128::new(GenericArray::from_slice(key), iv)),
            (24, false) => Ctr::A192(Ctr128::new(GenericArray::from_slice(key), iv)),
            (32, false) => Ctr::A256(Ctr128::new(GenericArray::from_slice(key), iv)),
            (16, true) => Ctr::G128(Ctr32::new(GenericArray::from_slice(key), iv)),
            (24, true) => Ctr::G192(Ctr32::new(GenericArray::from_slice(key), iv)),
            (32, true) => Ctr::G256(Ctr32::new(GenericArray::from_slice(key), iv)),
            _ => return None,
        })
    }

    fn apply(&mut self, data: &mut [u8]) {
        match self {
            Ctr::A128(c) => c.apply_keystream(data),
            Ctr::A192(c) => c.apply_keystream(data),
            Ctr::A256(c) => c.apply_keystream(data),
            Ctr::G128(c) => c.apply_keystream(data),
            Ctr::G192(c) => c.apply_keystream(data),
            Ctr::G256(c) => c.apply_keystream(data),
        }
    }
}

/// A universal hash fed in arbitrary chunks, zero-padding each section to 16 bytes.
struct Mac<H: UniversalHash> {
    hash: Option<H>,
    pending: [u8; 16],
    pending_len: usize,
}

impl<H: UniversalHash> Mac<H> {
    fn new(hash: H) -> Self {
        Mac {
            hash: Some(hash),
            pending: [0; 16],
            pending_len: 0,
        }
    }

    fn absorb(&mut self, mut data: &[u8]) {
        let Some(hash) = self.hash.as_mut() else {
            return;
        };
        if self.pending_len > 0 {
            let take = (16 - self.pending_len).min(data.len());
            self.pending[self.pending_len..self.pending_len + take].copy_from_slice(&data[..take]);
            self.pending_len += take;
            data = &data[take..];
            if self.pending_len < 16 {
                return;
            }
            hash.update_padded(&self.pending);
            self.pending_len = 0;
        }
        let full = data.len() / 16 * 16;
        if full > 0 {
            hash.update_padded(&data[..full]);
        }
        let rest = &data[full..];
        self.pending[..rest.len()].copy_from_slice(rest);
        self.pending_len = rest.len();
    }

    fn pad(&mut self) {
        if self.pending_len > 0 {
            if let Some(hash) = self.hash.as_mut() {
                hash.update_padded(&self.pending[..self.pending_len]);
            }
            self.pending_len = 0;
        }
    }

    fn finish(&mut self, lengths: &[u8; 16]) -> [u8; 16] {
        self.pad();
        let mut out = [0u8; 16];
        if let Some(mut hash) = self.hash.take() {
            hash.update_padded(lengths);
            out.copy_from_slice(&hash.finalize());
        }
        out
    }
}

enum Mode {
    Cbc {
        block: Block,
        chain: [u8; 16],
        buffer: [u8; 16],
        buffered: usize,
    },
    Ctr(Ctr),
    Gcm {
        ctr: Ctr,
        mac: Mac<GHash>,
        mask: [u8; 16],
    },
    Chacha {
        stream: ChaCha20,
        mac: Mac<Poly1305>,
    },
}

pub struct MalCipher {
    mode: Mode,
    encrypt: bool,
    padding: bool,
    aad_len: u64,
    data_len: u64,
    in_data: bool,
    finished: bool,
    tag: [u8; 16],
    tag_set: bool,
    expected_len: usize,
}

fn gcm_j0(iv: &[u8], h: &[u8; 16]) -> [u8; 16] {
    let mut j0 = [0u8; 16];
    if iv.len() == 12 {
        j0[..12].copy_from_slice(iv);
        j0[15] = 1;
        return j0;
    }
    let mut hash = GHash::new(GenericArray::from_slice(h));
    hash.update_padded(iv);
    let mut lengths = [0u8; 16];
    lengths[8..].copy_from_slice(&((iv.len() as u64) * 8).to_be_bytes());
    hash.update_padded(&lengths);
    j0.copy_from_slice(&hash.finalize());
    j0
}

impl MalCipher {
    fn new(kind: u32, encrypt: bool, key: &[u8], iv: &[u8]) -> Result<MalCipher, i32> {
        let mode = match kind {
            1..=3 => {
                let block = Block::new(key).ok_or(MAL_CIPHER_INVALID_KEY)?;
                if iv.len() != 16 {
                    return Err(MAL_CIPHER_INVALID_IV);
                }
                let mut chain = [0u8; 16];
                chain.copy_from_slice(iv);
                Mode::Cbc {
                    block,
                    chain,
                    buffer: [0; 16],
                    buffered: 0,
                }
            }
            4..=6 => {
                Block::new(key).ok_or(MAL_CIPHER_INVALID_KEY)?;
                let counter: [u8; 16] = iv.try_into().map_err(|_| MAL_CIPHER_INVALID_IV)?;
                Mode::Ctr(Ctr::new(key, &counter, false).ok_or(MAL_CIPHER_INVALID_KEY)?)
            }
            7..=9 => {
                let block = Block::new(key).ok_or(MAL_CIPHER_INVALID_KEY)?;
                if iv.is_empty() {
                    return Err(MAL_CIPHER_INVALID_IV);
                }
                let mut h = [0u8; 16];
                block.encrypt(&mut h);
                let j0 = gcm_j0(iv, &h);
                let mut mask = j0;
                block.encrypt(&mut mask);
                let mut counter = j0;
                let next = u32::from_be_bytes([j0[12], j0[13], j0[14], j0[15]]).wrapping_add(1);
                counter[12..].copy_from_slice(&next.to_be_bytes());
                let ctr = Ctr::new(key, &counter, true).ok_or(MAL_CIPHER_INVALID_KEY)?;
                Mode::Gcm {
                    ctr,
                    mac: Mac::new(GHash::new(GenericArray::from_slice(&h))),
                    mask,
                }
            }
            10 => {
                if key.len() != 32 {
                    return Err(MAL_CIPHER_INVALID_KEY);
                }
                if iv.len() != 12 {
                    return Err(MAL_CIPHER_INVALID_IV);
                }
                let mut stream =
                    ChaCha20::new(GenericArray::from_slice(key), GenericArray::from_slice(iv));
                let mut block0 = [0u8; 64];
                stream.apply_keystream(&mut block0);
                let mac = Mac::new(Poly1305::new(GenericArray::from_slice(&block0[..32])));
                Mode::Chacha { stream, mac }
            }
            _ => return Err(MAL_CIPHER_UNKNOWN),
        };
        Ok(MalCipher {
            mode,
            encrypt,
            padding: true,
            aad_len: 0,
            data_len: 0,
            in_data: false,
            finished: false,
            tag: [0; 16],
            tag_set: false,
            expected_len: 16,
        })
    }

    fn set_aad(&mut self, aad: &[u8]) -> i32 {
        if self.finished || self.in_data {
            return MAL_CIPHER_INVALID_STATE;
        }
        match &mut self.mode {
            Mode::Gcm { mac, .. } => mac.absorb(aad),
            Mode::Chacha { mac, .. } => mac.absorb(aad),
            _ => return MAL_CIPHER_INVALID_STATE,
        }
        self.aad_len += aad.len() as u64;
        MAL_CIPHER_OK
    }

    fn begin_data(&mut self) {
        if self.in_data {
            return;
        }
        self.in_data = true;
        match &mut self.mode {
            Mode::Gcm { mac, .. } => mac.pad(),
            Mode::Chacha { mac, .. } => mac.pad(),
            _ => {}
        }
    }

    /// Writes at most `input.len() + 16` bytes.
    fn update(&mut self, input: &[u8], out: &mut [u8]) -> Result<usize, i32> {
        if self.finished {
            return Err(MAL_CIPHER_INVALID_STATE);
        }
        if out.len() < input.len() + 16 {
            return Err(MAL_CIPHER_BUFFER_TOO_SMALL);
        }
        self.begin_data();
        self.data_len += input.len() as u64;
        let encrypt = self.encrypt;
        let padding = self.padding;
        match &mut self.mode {
            Mode::Cbc {
                block,
                chain,
                buffer,
                buffered,
            } => {
                let total = *buffered + input.len();
                let mut blocks = total / 16;
                // A padded decrypt keeps its last whole block for final() to unpad.
                if !encrypt && padding && total.is_multiple_of(16) && blocks > 0 {
                    blocks -= 1;
                }
                let mut consumed = 0usize;
                let mut written = 0usize;
                for _ in 0..blocks {
                    let mut current = [0u8; 16];
                    let from_buffer = *buffered;
                    current[..from_buffer].copy_from_slice(&buffer[..from_buffer]);
                    let need = 16 - from_buffer;
                    current[from_buffer..].copy_from_slice(&input[consumed..consumed + need]);
                    consumed += need;
                    *buffered = 0;
                    cbc_block(block, chain, &mut current, encrypt);
                    out[written..written + 16].copy_from_slice(&current);
                    written += 16;
                }
                let rest = &input[consumed..];
                buffer[*buffered..*buffered + rest.len()].copy_from_slice(rest);
                *buffered += rest.len();
                Ok(written)
            }
            Mode::Ctr(ctr) => {
                out[..input.len()].copy_from_slice(input);
                ctr.apply(&mut out[..input.len()]);
                Ok(input.len())
            }
            Mode::Gcm { ctr, mac, .. } => {
                out[..input.len()].copy_from_slice(input);
                if !encrypt {
                    mac.absorb(input);
                }
                ctr.apply(&mut out[..input.len()]);
                if encrypt {
                    mac.absorb(&out[..input.len()]);
                }
                Ok(input.len())
            }
            Mode::Chacha { stream, mac } => {
                out[..input.len()].copy_from_slice(input);
                if !encrypt {
                    mac.absorb(input);
                }
                stream.apply_keystream(&mut out[..input.len()]);
                if encrypt {
                    mac.absorb(&out[..input.len()]);
                }
                Ok(input.len())
            }
        }
    }

    /// Writes at most 16 bytes.
    fn finish(&mut self, out: &mut [u8]) -> Result<usize, i32> {
        if self.finished {
            return Err(MAL_CIPHER_INVALID_STATE);
        }
        if out.len() < 16 {
            return Err(MAL_CIPHER_BUFFER_TOO_SMALL);
        }
        self.begin_data();
        self.finished = true;
        let encrypt = self.encrypt;
        let padding = self.padding;
        let aad_len = self.aad_len;
        let data_len = self.data_len;
        match &mut self.mode {
            Mode::Cbc {
                block,
                chain,
                buffer,
                buffered,
            } => {
                if encrypt {
                    if !padding {
                        return if *buffered == 0 {
                            Ok(0)
                        } else {
                            Err(MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH)
                        };
                    }
                    let pad = (16 - *buffered) as u8;
                    let mut current = *buffer;
                    for byte in current[*buffered..].iter_mut() {
                        *byte = pad;
                    }
                    cbc_block(block, chain, &mut current, true);
                    out[..16].copy_from_slice(&current);
                    return Ok(16);
                }
                if !padding {
                    return if *buffered == 0 {
                        Ok(0)
                    } else {
                        Err(MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH)
                    };
                }
                if *buffered != 16 {
                    return Err(MAL_CIPHER_WRONG_FINAL_BLOCK_LENGTH);
                }
                let mut current = *buffer;
                cbc_block(block, chain, &mut current, false);
                let pad = current[15] as usize;
                let mut bad = (pad == 0) as u8 | (pad > 16) as u8;
                if bad == 0 {
                    for &byte in &current[16 - pad..] {
                        bad |= (byte as usize != pad) as u8;
                    }
                }
                if bad != 0 {
                    return Err(MAL_CIPHER_BAD_DECRYPT);
                }
                out[..16 - pad].copy_from_slice(&current[..16 - pad]);
                Ok(16 - pad)
            }
            Mode::Ctr(_) => Ok(0),
            Mode::Gcm { mac, mask, .. } => {
                let mut lengths = [0u8; 16];
                lengths[..8].copy_from_slice(&(aad_len * 8).to_be_bytes());
                lengths[8..].copy_from_slice(&(data_len * 8).to_be_bytes());
                let mut tag = mac.finish(&lengths);
                for (t, m) in tag.iter_mut().zip(mask.iter()) {
                    *t ^= m;
                }
                self.seal_or_check(tag)
            }
            Mode::Chacha { mac, .. } => {
                let mut lengths = [0u8; 16];
                lengths[..8].copy_from_slice(&aad_len.to_le_bytes());
                lengths[8..].copy_from_slice(&data_len.to_le_bytes());
                let tag = mac.finish(&lengths);
                self.seal_or_check(tag)
            }
        }
    }

    fn seal_or_check(&mut self, tag: [u8; 16]) -> Result<usize, i32> {
        if self.encrypt {
            self.tag = tag;
            return Ok(0);
        }
        if !self.tag_set {
            return Err(MAL_CIPHER_AUTH_FAILED);
        }
        let difference = tag[..self.expected_len]
            .iter()
            .zip(&self.tag[..self.expected_len])
            .fold(0u8, |acc, (a, b)| acc | (a ^ b));
        if difference != 0 {
            Err(MAL_CIPHER_AUTH_FAILED)
        } else {
            Ok(0)
        }
    }
}

fn cbc_block(block: &Block, chain: &mut [u8; 16], current: &mut [u8; 16], encrypt: bool) {
    if encrypt {
        for (c, p) in current.iter_mut().zip(chain.iter()) {
            *c ^= p;
        }
        block.encrypt(current);
        *chain = *current;
    } else {
        let saved = *current;
        block.decrypt(current);
        for (c, p) in current.iter_mut().zip(chain.iter()) {
            *c ^= p;
        }
        *chain = saved;
    }
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

unsafe fn slice_mut<'a>(ptr: *mut u8, len: usize) -> &'a mut [u8] {
    if len == 0 || ptr.is_null() {
        &mut []
    } else {
        unsafe { std::slice::from_raw_parts_mut(ptr, len) }
    }
}

/// Bytes the caller must provide for one cipher state.
#[unsafe(no_mangle)]
pub extern "C" fn mal_cipher_state_size() -> usize {
    std::mem::size_of::<MalCipher>()
}

/// Builds a cipher in caller-owned storage. The state owns no heap memory, so
/// the caller releases it by freeing (and scrubbing) the storage; nothing to drop.
///
/// # Safety
/// `storage` is writable for `size` bytes, `key`/`iv` are readable for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_init(
    storage: *mut u8,
    size: usize,
    kind: u32,
    encrypt: bool,
    key: *const u8,
    key_len: usize,
    iv: *const u8,
    iv_len: usize,
) -> i32 {
    if storage.is_null()
        || size < std::mem::size_of::<MalCipher>()
        || !(storage as usize).is_multiple_of(std::mem::align_of::<MalCipher>())
    {
        return MAL_CIPHER_INVALID_STATE;
    }
    match unsafe { MalCipher::new(kind, encrypt, slice(key, key_len), slice(iv, iv_len)) } {
        Ok(cipher) => {
            unsafe { std::ptr::write(storage as *mut MalCipher, cipher) };
            MAL_CIPHER_OK
        }
        Err(code) => code,
    }
}

/// # Safety
/// `cipher` is a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_set_padding(cipher: *mut MalCipher, padding: bool) -> i32 {
    let cipher = unsafe { &mut *cipher };
    if cipher.finished {
        return MAL_CIPHER_INVALID_STATE;
    }
    cipher.padding = padding;
    MAL_CIPHER_OK
}

/// # Safety
/// `cipher` is a live handle and `aad` is readable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_set_aad(
    cipher: *mut MalCipher,
    aad: *const u8,
    len: usize,
) -> i32 {
    unsafe { (*cipher).set_aad(slice(aad, len)) }
}

/// # Safety
/// `cipher` is a live handle, `input` is readable and `out` writable for their
/// lengths, and `written` is writable. `out_cap` must be at least `input_len + 16`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_update(
    cipher: *mut MalCipher,
    input: *const u8,
    input_len: usize,
    out: *mut u8,
    out_cap: usize,
    written: *mut usize,
) -> i32 {
    match unsafe { (*cipher).update(slice(input, input_len), slice_mut(out, out_cap)) } {
        Ok(n) => {
            unsafe { *written = n };
            MAL_CIPHER_OK
        }
        Err(code) => code,
    }
}

/// # Safety
/// `cipher` is a live handle, `out` is writable for `out_cap` (>= 16) bytes and
/// `written` is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_final(
    cipher: *mut MalCipher,
    out: *mut u8,
    out_cap: usize,
    written: *mut usize,
) -> i32 {
    match unsafe { (*cipher).finish(slice_mut(out, out_cap)) } {
        Ok(n) => {
            unsafe { *written = n };
            MAL_CIPHER_OK
        }
        Err(code) => code,
    }
}

/// Copies the first `len` (<= 16) bytes of the computed tag after an encrypting final.
///
/// # Safety
/// `cipher` is a live handle and `out` is writable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_get_tag(
    cipher: *const MalCipher,
    out: *mut u8,
    len: usize,
) -> i32 {
    let cipher = unsafe { &*cipher };
    if cipher.encrypt && cipher.finished && len <= 16 {
        unsafe { slice_mut(out, len) }.copy_from_slice(&cipher.tag[..len]);
        return MAL_CIPHER_OK;
    }
    MAL_CIPHER_INVALID_STATE
}

/// The expected tag for a decrypting final; a shorter tag compares its prefix.
///
/// # Safety
/// `cipher` is a live handle and `tag` is readable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mal_cipher_set_tag(
    cipher: *mut MalCipher,
    tag: *const u8,
    len: usize,
) -> i32 {
    let cipher = unsafe { &mut *cipher };
    if cipher.encrypt || cipher.finished || len == 0 || len > 16 {
        return MAL_CIPHER_INVALID_STATE;
    }
    cipher.tag = [0; 16];
    cipher.tag[..len].copy_from_slice(unsafe { slice(tag, len) });
    cipher.tag_set = true;
    cipher.expected_len = len;
    MAL_CIPHER_OK
}
