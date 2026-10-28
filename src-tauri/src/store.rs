use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::crypto::{DEFAULT_COST, KdfCost, Keys};
use crate::error::{AppError, Result};
use crate::model::Data;

struct Unlocked {
    keys: Keys,
    data: Data,
}

/// Configuración cifrada en disco; los datos descifrados solo viven en memoria mientras está desbloqueada.
pub struct Store {
    path: PathBuf,
    cost: KdfCost,
    inner: Mutex<Option<Unlocked>>,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self::with_cost(path, DEFAULT_COST)
    }

    pub fn with_cost(path: PathBuf, cost: KdfCost) -> Self {
        Self { path, cost, inner: Mutex::new(None) }
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    fn save(&self, keys: &Keys, data: &Data) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(data)?);
        let blob = keys.encrypt(&plain)?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, blob)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Desbloquea; si aún no existe el fichero, crea uno nuevo con esa contraseña maestra.
    pub fn unlock(&self, password: &str) -> Result<()> {
        if password.is_empty() {
            return Err(AppError::msg("masterEmpty"));
        }
        let unlocked = if self.exists() {
            let blob = fs::read(&self.path)?;
            let (keys, plain) = Keys::decrypt(password, &blob)?;
            Unlocked { keys, data: serde_json::from_slice(&plain)? }
        } else {
            let keys = Keys::new(password, self.cost)?;
            let data = Data::default();
            self.save(&keys, &data)?;
            Unlocked { keys, data }
        };
        *self.inner.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    /// Comprueba la contraseña maestra contra el fichero sin tocar el estado.
    pub fn verify(&self, password: &str) -> Result<()> {
        let blob = fs::read(&self.path)?;
        Keys::decrypt(password, &blob).map(|_| ())
    }

    pub fn lock(&self) {
        *self.inner.lock().unwrap() = None;
    }

    /// Borra el fichero cifrado y vacía la memoria: la app queda como en el primer arranque.
    /// Solo se permite con la app desbloqueada, para que no sea accesible sin la contraseña maestra.
    pub fn erase(&self) -> Result<()> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_none() {
            return Err(AppError::Locked);
        }
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()), // no se pudo borrar: se conserva el estado en memoria
        }
        *guard = None;
        Ok(())
    }

    pub fn read<R>(&self, f: impl FnOnce(&Data) -> R) -> Result<R> {
        let guard = self.inner.lock().unwrap();
        Ok(f(&guard.as_ref().ok_or(AppError::Locked)?.data))
    }

    /// Muta una copia y la persiste; solo si el guardado tiene éxito se sustituye el estado en memoria.
    pub fn write<R>(&self, f: impl FnOnce(&mut Data) -> Result<R>) -> Result<R> {
        let mut guard = self.inner.lock().unwrap();
        let st = guard.as_mut().ok_or(AppError::Locked)?;
        let mut data = st.data.clone();
        let out = f(&mut data)?;
        self.save(&st.keys, &data)?;
        st.data = data;
        Ok(out)
    }

    pub fn change_password(&self, new_password: &str) -> Result<()> {
        if new_password.is_empty() {
            return Err(AppError::msg("masterEmpty"));
        }
        let mut guard = self.inner.lock().unwrap();
        let st = guard.as_mut().ok_or(AppError::Locked)?;
        let keys = Keys::new(new_password, self.cost)?;
        self.save(&keys, &st.data)?;
        st.keys = keys;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Vault;

    const FAST: KdfCost = KdfCost { m_kib: 8, t: 1, p: 1 };

    fn vault(client: &str) -> Vault {
        Vault {
            id: client.into(),
            client: client.into(),
            path: format!("/tmp/{client}.kdbx").into(),
            keyfile: None,
            password: Some(Zeroizing::new("secreto".into())),
            ..Default::default()
        }
    }

    #[test]
    fn persists_and_stays_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let s = Store::with_cost(path.clone(), FAST);
        s.unlock("m").unwrap();
        s.write(|d| { d.vaults.push(vault("acme")); Ok(()) }).unwrap();

        let raw = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("acme"));
        assert!(!String::from_utf8_lossy(&raw).contains("secreto"));

        let s2 = Store::with_cost(path, FAST);
        assert!(matches!(s2.unlock("x"), Err(AppError::WrongPassword)));
        s2.unlock("m").unwrap();
        assert_eq!(s2.read(|d| d.vaults.len()).unwrap(), 1);
    }

    #[test]
    fn erase_requires_unlock_and_resets_to_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let s = Store::with_cost(path.clone(), FAST);
        s.unlock("m").unwrap();
        s.write(|d| { d.vaults.push(vault("acme")); Ok(()) }).unwrap();
        s.lock();
        assert!(matches!(s.erase(), Err(AppError::Locked)), "bloqueada no puede borrar");
        assert!(path.is_file(), "y el fichero sigue ahí");

        s.unlock("m").unwrap();
        s.erase().unwrap();
        assert!(!path.exists());
        assert!(!s.exists() && !s.is_unlocked());

        // Como en el primer arranque: una contraseña nueva cualquiera crea un almacén vacío.
        s.unlock("otra").unwrap();
        assert_eq!(s.read(|d| d.vaults.len()).unwrap(), 0);
    }

    #[test]
    fn locked_rejects_access_and_change_password_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let s = Store::with_cost(path.clone(), FAST);
        assert!(matches!(s.read(|_| ()), Err(AppError::Locked)));
        s.unlock("a").unwrap();
        s.write(|d| { d.vaults.push(vault("x")); Ok(()) }).unwrap();
        s.change_password("b").unwrap();
        s.lock();
        let s2 = Store::with_cost(path, FAST);
        assert!(s2.unlock("a").is_err());
        s2.unlock("b").unwrap();
        assert_eq!(s2.read(|d| d.vaults.len()).unwrap(), 1);
    }
}
