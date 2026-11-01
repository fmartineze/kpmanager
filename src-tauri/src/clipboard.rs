//! Portapapeles para secretos: no deja rastro en el historial de Windows ni en el portapapeles en la nube,
//! y se vacía solo pasado un tiempo, pero únicamente si todavía contiene lo que se copió desde aquí.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};

type Hash = [u8; 32];

fn hash(text: &str) -> Hash {
    Sha256::digest(text.as_bytes()).into()
}

#[cfg(windows)]
mod sys {
    use super::{AppError, Result};
    use std::time::Duration;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
    use windows::core::w;

    const CF_UNICODETEXT: u32 = 13;

    /// Cierra el portapapeles al salir, pase lo que pase.
    struct Open;

    impl Open {
        /// Otro programa puede tenerlo abierto un instante: se reintenta unas veces.
        fn new() -> Result<Self> {
            for _ in 0..20 {
                if unsafe { OpenClipboard(Some(HWND::default())) }.is_ok() {
                    return Ok(Open);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(AppError::msg("clipboardBusy"))
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    /// Reserva memoria global con `bytes`; el sistema se queda con ella al entregarla al portapapeles.
    unsafe fn alloc(bytes: &[u8]) -> Result<HGLOBAL> {
        let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.map_err(|_| AppError::msg("clipboardBusy"))?;
        let p = unsafe { GlobalLock(h) } as *mut u8;
        if p.is_null() {
            return Err(AppError::msg("clipboardBusy"));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let _ = GlobalUnlock(h);
        }
        Ok(h)
    }

    pub fn write(text: &str) -> Result<()> {
        let _open = Open::new()?;
        unsafe {
            EmptyClipboard().map_err(|_| AppError::msg("clipboardBusy"))?;
            let mut wide: Vec<u16> = text.encode_utf16().collect();
            wide.push(0);
            let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
            let h = alloc(bytes)?;
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(h.0))).map_err(|_| AppError::msg("clipboardBusy"))?;
            // Sin historial (Win+V), sin sincronizar con la nube y sin que lo procesen monitores del portapapeles.
            let zero = 0u32.to_le_bytes();
            for name in [
                w!("ExcludeClipboardContentFromMonitorProcessing"),
                w!("CanIncludeInClipboardHistory"),
                w!("CanUploadToCloudClipboard"),
            ] {
                let fmt = RegisterClipboardFormatW(name);
                if fmt != 0 {
                    if let Ok(h) = alloc(&zero) {
                        let _ = SetClipboardData(fmt, Some(HANDLE(h.0)));
                    }
                }
            }
            wipe(wide);
        }
        Ok(())
    }

    /// Sobrescribe el búfer de la copia local antes de soltarlo.
    fn wipe(mut v: Vec<u16>) {
        for x in v.iter_mut() {
            unsafe { std::ptr::write_volatile(x, 0) };
        }
    }

    pub fn read() -> Option<String> {
        let _open = Open::new().ok()?;
        unsafe {
            let h = GetClipboardData(CF_UNICODETEXT).ok()?;
            let g = HGLOBAL(h.0);
            let p = GlobalLock(g) as *const u16;
            if p.is_null() {
                return None;
            }
            let max = GlobalSize(g) / 2;
            let mut len = 0;
            while len < max && *p.add(len) != 0 {
                len += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
            let _ = GlobalUnlock(g);
            Some(s)
        }
    }

    pub fn clear() -> Result<()> {
        let _open = Open::new()?;
        unsafe { EmptyClipboard() }.map_err(|_| AppError::msg("clipboardBusy"))
    }
}

#[cfg(not(windows))]
mod sys {
    use super::{AppError, Result};

    fn board() -> Result<arboard::Clipboard> {
        arboard::Clipboard::new().map_err(|_| AppError::msg("clipboardBusy"))
    }

    pub fn write(text: &str) -> Result<()> {
        board()?.set_text(text.to_owned()).map_err(|_| AppError::msg("clipboardBusy"))
    }

    pub fn read() -> Option<String> {
        board().ok()?.get_text().ok()
    }

    pub fn clear() -> Result<()> {
        board()?.clear().map_err(|_| AppError::msg("clipboardBusy"))
    }
}

#[derive(Default)]
struct Inner {
    /// Huella de lo último copiado desde la app (nunca el texto).
    last: Mutex<Option<Hash>>,
    /// Número de copia: un temporizador antiguo no debe borrar una copia más reciente.
    generation: AtomicU64,
}

#[derive(Default)]
pub struct Clipboard(Arc<Inner>);

impl Clipboard {
    /// Copia `text`. Con `clear_after`, lo borra pasado ese tiempo si sigue siendo lo mismo.
    pub fn copy_secret(&self, text: &str, clear_after: Option<Duration>) -> Result<()> {
        sys::write(text)?;
        let inner = Arc::clone(&self.0);
        *inner.last.lock().unwrap() = Some(hash(text));
        let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(wait) = clear_after {
            std::thread::spawn(move || {
                std::thread::sleep(wait);
                if inner.generation.load(Ordering::SeqCst) == generation {
                    inner.clear_if_ours();
                }
            });
        }
        Ok(())
    }

    pub fn clear_if_ours(&self) {
        self.0.clear_if_ours();
    }
}

impl Inner {
    /// Vacía el portapapeles solo si aún contiene lo que copió la app. Lo que el usuario copió después
    /// no se toca.
    fn clear_if_ours(&self) {
        let Some(ours) = self.last.lock().unwrap().take() else { return };
        // Invalida los temporizadores pendientes.
        self.generation.fetch_add(1, Ordering::SeqCst);
        if sys::read().is_some_and(|now| hash(&now) == ours) {
            let _ = sys::clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_distinguishes_values() {
        assert_eq!(hash("a"), hash("a"));
        assert_ne!(hash("a"), hash("b"));
    }

    /// Toca el portapapeles real: se ejecuta a mano con `cargo test -- --ignored clipboard`.
    #[test]
    #[ignore]
    fn real_clipboard_roundtrip_and_conditional_clear() {
        let c = Clipboard::default();
        c.copy_secret("secreto-ñ-€", None).unwrap();
        assert_eq!(sys::read().as_deref(), Some("secreto-ñ-€"));
        c.clear_if_ours();
        assert_eq!(sys::read().filter(|s| !s.is_empty()), None, "se vacía lo propio");

        c.copy_secret("mio", None).unwrap();
        sys::write("del usuario").unwrap();
        c.clear_if_ours();
        assert_eq!(sys::read().as_deref(), Some("del usuario"), "lo copiado después no se toca");

        // El temporizador no borra si hay una copia más reciente.
        c.copy_secret("uno", Some(Duration::from_millis(200))).unwrap();
        c.copy_secret("dos", None).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(sys::read().as_deref(), Some("dos"));
        c.copy_secret("tres", Some(Duration::from_millis(200))).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(sys::read().filter(|s| !s.is_empty()), None, "el temporizador vacía lo propio");
    }

    #[test]
    fn clearing_without_a_copy_is_a_noop() {
        Clipboard::default().clear_if_ours();
    }
}
