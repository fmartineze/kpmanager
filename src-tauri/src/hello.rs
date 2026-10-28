//! Desbloqueo con Windows Hello.
//!
//! Al activarlo se crea una credencial asimétrica protegida por Hello (`KeyCredentialManager`) y se
//! firma un reto aleatorio. La firma RSA PKCS#1 es determinista y solo se obtiene tras autenticarse con
//! Hello, así que se usa como clave para cifrar la contraseña maestra en `hello.bin`.
//! Formato: `KPH1 | reto[32] | nonce[24] | texto cifrado`.

use std::fs;
use std::path::PathBuf;

use chacha20poly1305::aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

const MAGIC: &[u8; 4] = b"KPH1";
const CHALLENGE_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 4 + CHALLENGE_LEN;

fn derive_key(signature: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut h = Sha256::new();
    h.update(b"kpmanager/hello/v1");
    h.update(signature);
    Zeroizing::new(h.finalize().into())
}

fn wrap(signature: &[u8], challenge: &[u8; CHALLENGE_LEN], password: &str) -> Result<Vec<u8>> {
    let key = derive_key(signature);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let mut header = [0u8; HEADER_LEN];
    header[..4].copy_from_slice(MAGIC);
    header[4..].copy_from_slice(challenge);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: password.as_bytes(), aad: &header })
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn challenge_of(blob: &[u8]) -> Result<[u8; CHALLENGE_LEN]> {
    if blob.len() < HEADER_LEN + NONCE_LEN + 16 || &blob[..4] != MAGIC {
        return Err(AppError::BadFormat);
    }
    Ok(blob[4..HEADER_LEN].try_into().unwrap())
}

fn unwrap_password(signature: &[u8], blob: &[u8]) -> Result<Zeroizing<String>> {
    challenge_of(blob)?;
    let key = derive_key(signature);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let nonce = XNonce::from_slice(&blob[HEADER_LEN..HEADER_LEN + NONCE_LEN]);
    let pt = cipher
        .decrypt(nonce, Payload { msg: &blob[HEADER_LEN + NONCE_LEN..], aad: &blob[..HEADER_LEN] })
        .map_err(|_| AppError::Invalid("Windows Hello ya no coincide con la configuración guardada. Vuelve a activarlo".into()))?;
    String::from_utf8(pt).map(Zeroizing::new).map_err(|_| AppError::BadFormat)
}

#[cfg(windows)]
mod platform {
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};
    use windows::core::{HSTRING, PCWSTR, w};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use zeroize::Zeroizing;

    use crate::error::{AppError, Result};

    const NAME: &str = "KPManager.MasterKey";

    /// Mientras vive, un hilo busca la ventana de credenciales de Windows y la trae al frente:
    /// Windows la abre sin foco cuando la pide una app de escritorio.
    struct PromptFocus(Arc<AtomicBool>);

    impl PromptFocus {
        fn start() -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            std::thread::spawn(move || {
                // La ventana tarda un instante en aparecer; se reintenta unos 15 s.
                for _ in 0..150 {
                    if flag.load(Ordering::Relaxed) {
                        return;
                    }
                    unsafe {
                        if let Ok(h) = FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()) {
                            if !h.is_invalid() {
                                let _ = SetForegroundWindow(h);
                                return;
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            Self(stop)
        }
    }

    impl Drop for PromptFocus {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    fn init() {
        // Los hilos de Rust no inicializan COM; si ya estaba inicializado el error es inofensivo.
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
    }

    fn err(e: windows::core::Error) -> AppError {
        AppError::Invalid(format!("Windows Hello: {}", e.message()))
    }

    fn check(status: KeyCredentialStatus) -> Result<()> {
        match status {
            KeyCredentialStatus::Success => Ok(()),
            KeyCredentialStatus::UserCanceled => Err(AppError::Invalid("Windows Hello cancelado".into())),
            KeyCredentialStatus::NotFound => {
                Err(AppError::Invalid("No hay credencial de Windows Hello. Vuelve a activarlo".into()))
            }
            KeyCredentialStatus::SecurityDeviceLocked => {
                Err(AppError::Invalid("El dispositivo de seguridad está bloqueado".into()))
            }
            other => Err(AppError::Invalid(format!("Windows Hello no disponible ({other:?})"))),
        }
    }

    fn buffer(bytes: &[u8]) -> windows::core::Result<IBuffer> {
        let w = DataWriter::new()?;
        w.WriteBytes(bytes)?;
        w.DetachBuffer()
    }

    fn sign_with(cred: &KeyCredential, challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let buf = buffer(challenge).map_err(err)?;
        let res = cred.RequestSignAsync(&buf).map_err(err)?.join().map_err(err)?;
        check(res.Status().map_err(err)?)?;
        let sig = res.Result().map_err(err)?;
        let mut out = vec![0u8; sig.Length().map_err(err)? as usize];
        DataReader::FromBuffer(&sig).map_err(err)?.ReadBytes(&mut out).map_err(err)?;
        Ok(Zeroizing::new(out))
    }

    pub fn is_supported() -> bool {
        init();
        KeyCredentialManager::IsSupportedAsync()
            .and_then(|op| op.join())
            .unwrap_or(false)
    }

    /// (Re)crea la credencial y firma el reto: Hello pide autenticación.
    pub fn create_and_sign(challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        init();
        let _focus = PromptFocus::start();
        let r = KeyCredentialManager::RequestCreateAsync(
            &HSTRING::from(NAME),
            KeyCredentialCreationOption::ReplaceExisting,
        )
        .map_err(err)?
        .join()
        .map_err(err)?;
        check(r.Status().map_err(err)?)?;
        sign_with(&r.Credential().map_err(err)?, challenge)
    }

    pub fn sign(challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        init();
        let _focus = PromptFocus::start();
        let r = KeyCredentialManager::OpenAsync(&HSTRING::from(NAME)).map_err(err)?.join().map_err(err)?;
        check(r.Status().map_err(err)?)?;
        sign_with(&r.Credential().map_err(err)?, challenge)
    }

    pub fn delete() {
        init();
        let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(NAME)).and_then(|op| op.join());
    }
}

#[cfg(not(windows))]
mod platform {
    use zeroize::Zeroizing;

    use crate::error::{AppError, Result};

    fn unsupported() -> AppError {
        AppError::Invalid("Windows Hello solo está disponible en Windows".into())
    }

    pub fn is_supported() -> bool {
        false
    }
    pub fn create_and_sign(_: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        Err(unsupported())
    }
    pub fn sign(_: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        Err(unsupported())
    }
    pub fn delete() {}
}

pub fn supported() -> bool {
    platform::is_supported()
}

#[derive(Clone)]
pub struct Hello {
    path: PathBuf,
}

impl Hello {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn enabled(&self) -> bool {
        self.path.is_file()
    }

    /// Guarda la contraseña maestra cifrada con la firma de Hello. Bloquea hasta que el usuario se autentica.
    pub fn enable(&self, password: &str) -> Result<()> {
        let mut challenge = [0u8; CHALLENGE_LEN];
        OsRng.fill_bytes(&mut challenge);
        let sig = platform::create_and_sign(&challenge)?;
        let blob = wrap(&sig, &challenge, password)?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, blob)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Autentica con Hello y devuelve la contraseña maestra.
    pub fn unlock(&self) -> Result<Zeroizing<String>> {
        let blob = fs::read(&self.path)?;
        let sig = platform::sign(&challenge_of(&blob)?)?;
        unwrap_password(&sig, &blob)
    }

    pub fn disable(&self) {
        let _ = fs::remove_file(&self.path);
        platform::delete();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_roundtrip_with_same_signature() {
        let ch = [7u8; CHALLENGE_LEN];
        let blob = wrap(b"firma", &ch, "maestra").unwrap();
        assert_eq!(challenge_of(&blob).unwrap(), ch);
        assert_eq!(&*unwrap_password(b"firma", &blob).unwrap(), "maestra");
    }

    #[test]
    fn different_signature_cannot_unwrap() {
        let blob = wrap(b"firma", &[1u8; CHALLENGE_LEN], "maestra").unwrap();
        assert!(unwrap_password(b"otra", &blob).is_err());
    }

    #[test]
    fn blob_does_not_contain_password_and_rejects_tampering() {
        let mut blob = wrap(b"firma", &[1u8; CHALLENGE_LEN], "maestra-secreta").unwrap();
        assert!(!String::from_utf8_lossy(&blob).contains("maestra-secreta"));
        blob[5] ^= 1; // el reto está autenticado
        assert!(unwrap_password(b"firma", &blob).is_err());
    }

    #[test]
    fn garbage_rejected() {
        assert!(challenge_of(b"x").is_err());
    }
}
