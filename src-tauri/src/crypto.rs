//! Formato de fichero: `KPM1 | m_kib u32 | t u32 | p u32 | salt[16] | nonce[24] | ciphertext`.
//! La cabecera (hasta el salt) se autentica como AAD.
//!
//! Un cambio incompatible del contenedor cambiaría la marca (`KPM2`…). Una versión que no lo entiende lo
//! reconoce por el prefijo `KPM` y pide actualizar la aplicación en vez de fallar con un error genérico.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

const MAGIC: &[u8; 4] = b"KPM1";
const MAGIC_PREFIX: &[u8; 3] = b"KPM";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 4 + 12 + SALT_LEN;

#[derive(Clone, Copy, Debug)]
pub struct KdfCost {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

pub const DEFAULT_COST: KdfCost = KdfCost { m_kib: 64 * 1024, t: 3, p: 1 };

/// Clave derivada + parámetros, para re-cifrar sin volver a pedir la maestra.
pub struct Keys {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; SALT_LEN],
    cost: KdfCost,
}

fn derive(password: &[u8], salt: &[u8; SALT_LEN], cost: KdfCost) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(cost.m_kib, cost.t, cost.p, Some(32))
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut *out)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    Ok(out)
}

impl Keys {
    pub fn new(password: &str, cost: KdfCost) -> Result<Self> {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive(password.as_bytes(), &salt, cost)?;
        Ok(Self { key, salt, cost })
    }

    fn header(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[..4].copy_from_slice(MAGIC);
        h[4..8].copy_from_slice(&self.cost.m_kib.to_le_bytes());
        h[8..12].copy_from_slice(&self.cost.t.to_le_bytes());
        h[12..16].copy_from_slice(&self.cost.p.to_le_bytes());
        h[16..].copy_from_slice(&self.salt);
        h
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let header = self.header();
        let ct = cipher
            .encrypt(&nonce, Payload { msg: plaintext, aad: &header })
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ct.len());
        out.extend_from_slice(&header);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// ¿Parece un fichero de datos de KP Manager (de esta versión o de una más nueva)? Solo mira la cabecera.
    pub fn looks_valid(blob: &[u8]) -> bool {
        blob.len() >= HEADER_LEN + NONCE_LEN + 16 && &blob[..3] == MAGIC_PREFIX
    }

    /// Comprueba la marca: `BadFormat` si no es de KP Manager y `dataNewer` si es de una versión más nueva.
    fn check_magic(blob: &[u8]) -> Result<()> {
        if !Self::looks_valid(blob) {
            return Err(AppError::BadFormat);
        }
        if &blob[..4] != MAGIC {
            return Err(AppError::msg_arg("dataNewer", ""));
        }
        Ok(())
    }

    /// Descifra con la clave que ya se tiene. Falla con `dataKeyChanged` si el fichero se volvió a cifrar con otra
    /// contraseña maestra (otro equipo la cambió): hay que desbloquear de nuevo.
    pub fn open_with_key(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        Self::check_magic(blob)?;
        if blob[4..HEADER_LEN] != self.header()[4..] {
            return Err(AppError::msg("dataKeyChanged"));
        }
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let nonce = XNonce::from_slice(&blob[HEADER_LEN..HEADER_LEN + NONCE_LEN]);
        let pt = cipher
            .decrypt(nonce, Payload { msg: &blob[HEADER_LEN + NONCE_LEN..], aad: &blob[..HEADER_LEN] })
            .map_err(|_| AppError::BadFormat)?;
        Ok(Zeroizing::new(pt))
    }

    pub fn decrypt(password: &str, blob: &[u8]) -> Result<(Self, Zeroizing<Vec<u8>>)> {
        Self::check_magic(blob)?;
        let u32_at = |i: usize| u32::from_le_bytes(blob[i..i + 4].try_into().unwrap());
        let cost = KdfCost { m_kib: u32_at(4), t: u32_at(8), p: u32_at(12) };
        // Evita que un fichero manipulado fuerce un coste absurdo.
        if cost.m_kib > 1 << 20 || cost.t > 32 || cost.p > 16 {
            return Err(AppError::BadFormat);
        }
        let salt: [u8; SALT_LEN] = blob[16..HEADER_LEN].try_into().unwrap();
        let key = derive(password.as_bytes(), &salt, cost)?;
        let cipher = XChaCha20Poly1305::new((&*key).into());
        let nonce = XNonce::from_slice(&blob[HEADER_LEN..HEADER_LEN + NONCE_LEN]);
        let pt = cipher
            .decrypt(nonce, Payload { msg: &blob[HEADER_LEN + NONCE_LEN..], aad: &blob[..HEADER_LEN] })
            .map_err(|_| AppError::WrongPassword)?;
        Ok((Self { key, salt, cost }, Zeroizing::new(pt)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfCost = KdfCost { m_kib: 8, t: 1, p: 1 };

    #[test]
    fn roundtrip() {
        let keys = Keys::new("maestra", FAST).unwrap();
        let blob = keys.encrypt(b"hola").unwrap();
        let (_, pt) = Keys::decrypt("maestra", &blob).unwrap();
        assert_eq!(&pt[..], b"hola");
    }

    #[test]
    fn wrong_password() {
        let blob = Keys::new("a", FAST).unwrap().encrypt(b"x").unwrap();
        assert!(matches!(Keys::decrypt("b", &blob), Err(AppError::WrongPassword)));
    }

    #[test]
    fn tampering_detected() {
        let mut blob = Keys::new("a", FAST).unwrap().encrypt(b"datos").unwrap();
        *blob.last_mut().unwrap() ^= 1;
        assert!(Keys::decrypt("a", &blob).is_err());
        let mut blob = Keys::new("a", FAST).unwrap().encrypt(b"datos").unwrap();
        blob[5] ^= 1; // cabecera (coste) autenticada
        assert!(Keys::decrypt("a", &blob).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(Keys::decrypt("a", b"nope"), Err(AppError::BadFormat)));
    }

    #[test]
    fn newer_container_is_recognised_and_open_with_key_follows_the_file() {
        let k = Keys::new("a", FAST).unwrap();
        let mut blob = k.encrypt(b"hola").unwrap();
        assert_eq!(&*k.open_with_key(&blob).unwrap(), b"hola");

        // Otro equipo cambió la contraseña: nueva sal, la clave que tenemos ya no sirve.
        let other = Keys::new("a", FAST).unwrap().encrypt(b"x").unwrap();
        assert!(matches!(k.open_with_key(&other), Err(AppError::Msg { code: "dataKeyChanged", .. })));

        blob[3] = b'2';
        assert!(Keys::looks_valid(&blob));
        assert!(matches!(Keys::decrypt("a", &blob), Err(AppError::Msg { code: "dataNewer", .. })));
        assert!(matches!(k.open_with_key(&blob), Err(AppError::Msg { code: "dataNewer", .. })));
        blob[..3].copy_from_slice(b"XYZ");
        assert!(!Keys::looks_valid(&blob));
        assert!(matches!(Keys::decrypt("a", &blob), Err(AppError::BadFormat)));
    }
}
