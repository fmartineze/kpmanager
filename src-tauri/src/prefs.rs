//! Preferencias no sensibles. Van en claro (`prefs.json`) porque hacen falta antes de desbloquear:
//! el atajo global se registra en el arranque y la bandeja actúa con la app bloqueada.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+K";

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /// `None` = sin atajo global.
    pub shortcut: Option<String>,
    /// Al minimizar, la ventana pasa a la bandeja del sistema en lugar de la barra de tareas.
    pub minimize_to_tray: bool,
    /// Cerrar la ventana la oculta a la bandeja; solo «Cerrar» en su menú termina la app.
    pub close_to_tray: bool,
    /// Al ocultar la ventana en la bandeja (cerrar o minimizar) se bloquea la app.
    pub lock_on_hide: bool,
    /// Alfabético; si es `false`, por último uso.
    pub sort_by_name: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { shortcut: Some(DEFAULT_SHORTCUT.into()), minimize_to_tray: false, close_to_tray: true, lock_on_hide: false, sort_by_name: false }
    }
}

pub struct PrefsState {
    path: PathBuf,
    inner: Mutex<Prefs>,
}

impl PrefsState {
    /// Un fichero ausente o ilegible se trata como valores por defecto.
    pub fn load(path: PathBuf) -> Self {
        let prefs = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { path, inner: Mutex::new(prefs) }
    }

    pub fn get(&self) -> Prefs {
        self.inner.lock().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut Prefs)) -> Result<Prefs> {
        let mut guard = self.inner.lock().unwrap();
        let mut next = guard.clone();
        f(&mut next);
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&next)?)?;
        fs::rename(&tmp, &self.path)?;
        *guard = next.clone();
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        let st = PrefsState::load(path.clone());
        assert_eq!(st.get(), Prefs::default());
        st.update(|p| {
            p.shortcut = None;
            p.minimize_to_tray = true;
        })
        .unwrap();
        let again = PrefsState::load(path);
        assert_eq!(again.get().shortcut, None);
        assert!(again.get().minimize_to_tray);
    }

    #[test]
    fn partial_file_keeps_defaults_and_garbage_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        fs::write(&path, br#"{"minimizeToTray":true}"#).unwrap();
        let p = PrefsState::load(path.clone()).get();
        assert!(p.minimize_to_tray);
        assert!(p.close_to_tray, "un fichero antiguo sin el campo usa el valor por defecto");
        assert_eq!(p.shortcut.as_deref(), Some(DEFAULT_SHORTCUT));
        fs::write(&path, b"{{no es json").unwrap();
        assert_eq!(PrefsState::load(path).get(), Prefs::default());
    }
}
