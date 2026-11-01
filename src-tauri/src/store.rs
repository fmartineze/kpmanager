use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{DEFAULT_COST, KdfCost, Keys};
use crate::error::{AppError, Result};
use crate::model::Data;

/// Huella del contenido cifrado que hay en disco, para saber si otro equipo lo ha cambiado.
type Sig = [u8; 32];

fn sig_of(blob: &[u8]) -> Sig {
    Sha256::digest(blob).into()
}

struct Unlocked {
    keys: Keys,
    data: Data,
    /// Huella del fichero tal como lo leímos o lo escribimos por última vez.
    sig: Sig,
}

/// Configuración cifrada en disco; los datos descifrados solo viven en memoria mientras está desbloqueada.
pub struct Store {
    /// Ubicación del fichero cifrado; el usuario puede cambiarla (ver `relocate` y `set_path`).
    path: Mutex<PathBuf>,
    cost: KdfCost,
    inner: Mutex<Option<Unlocked>>,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self::with_cost(path, DEFAULT_COST)
    }

    pub fn with_cost(path: PathBuf, cost: KdfCost) -> Self {
        Self { path: Mutex::new(path), cost, inner: Mutex::new(None) }
    }

    pub fn path(&self) -> PathBuf {
        self.path.lock().unwrap().clone()
    }

    pub fn exists(&self) -> bool {
        self.path().is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    fn save(&self, keys: &Keys, data: &Data) -> Result<Sig> {
        let plain = Zeroizing::new(serde_json::to_vec(data)?);
        let blob = keys.encrypt(&plain)?;
        let sig = sig_of(&blob);
        let path = self.path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, blob)?;
        // Un cliente de sincronización (OneDrive, Drive…) puede tener el fichero abierto un instante: se reintenta.
        let mut tries = 0;
        loop {
            match fs::rename(&tmp, &path) {
                Ok(()) => break,
                Err(e) if tries >= 5 => return Err(e.into()),
                Err(_) => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
        Ok(sig)
    }

    /// Si otro equipo (que sincroniza el mismo fichero) lo ha cambiado desde que lo leímos, pasa a usar su
    /// versión. Devuelve si hubo cambio. Falla con `dataKeyChanged` si cambió la contraseña maestra y con
    /// `dataNewer` si lo guardó una versión de la app más nueva.
    fn refresh(&self, st: &mut Unlocked) -> Result<bool> {
        let blob = match fs::read(self.path()) {
            Ok(b) => b,
            // Borrado por un conflicto de sincronización: el próximo guardado lo vuelve a crear.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        let sig = sig_of(&blob);
        if sig == st.sig {
            return Ok(false);
        }
        let plain = st.keys.open_with_key(&blob)?;
        st.data = Data::parse(&plain)?;
        st.sig = sig;
        Ok(true)
    }

    /// Recoge los cambios que otro equipo haya sincronizado. Devuelve si cambió algo.
    pub fn sync(&self) -> Result<bool> {
        let mut guard = self.inner.lock().unwrap();
        let st = guard.as_mut().ok_or(AppError::Locked)?;
        self.refresh(st)
    }

    /// Desbloquea; si aún no existe el fichero, crea uno nuevo con esa contraseña maestra.
    pub fn unlock(&self, password: &str) -> Result<()> {
        if password.is_empty() {
            return Err(AppError::msg("masterEmpty"));
        }
        let unlocked = if self.exists() {
            let blob = fs::read(self.path())?;
            let sig = sig_of(&blob);
            let (keys, plain) = Keys::decrypt(password, &blob)?;
            Unlocked { keys, data: Data::parse(&plain)?, sig }
        } else {
            let keys = Keys::new(password, self.cost)?;
            let mut data = Data::default();
            data.stamp();
            let sig = self.save(&keys, &data)?;
            Unlocked { keys, data, sig }
        };
        *self.inner.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    /// Comprueba la contraseña maestra contra el fichero sin tocar el estado.
    pub fn verify(&self, password: &str) -> Result<()> {
        let blob = fs::read(self.path())?;
        Keys::decrypt(password, &blob).map(|_| ())
    }

    pub fn lock(&self) {
        *self.inner.lock().unwrap() = None;
    }

    /// Cifra `plaintext` con la clave de la sesión (la contraseña maestra actual), con el mismo formato que `vaults.enc`.
    pub fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().ok_or(AppError::Locked)?.keys.encrypt(plaintext)
    }

    /// Borra el fichero cifrado y vacía la memoria: la app queda como en el primer arranque.
    /// Solo se permite con la app desbloqueada, para que no sea accesible sin la contraseña maestra.
    pub fn erase(&self) -> Result<()> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_none() {
            return Err(AppError::Locked);
        }
        match fs::remove_file(self.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()), // no se pudo borrar: se conserva el estado en memoria
        }
        *guard = None;
        Ok(())
    }

    /// Apunta a otro fichero sin tocar ninguno (usar uno existente, o volver a la ubicación predeterminada).
    /// Solo con la app bloqueada: los datos que hubiera en memoria son de otro fichero.
    pub fn set_path(&self, new: PathBuf) -> Result<()> {
        if self.is_unlocked() {
            return Err(AppError::msg("dataUnlockFirst"));
        }
        *self.path.lock().unwrap() = new;
        Ok(())
    }

    /// Mueve el fichero cifrado a `new` con la app desbloqueada: copia, comprueba que la copia es idéntica y
    /// pasa a usarla. Devuelve la ubicación anterior, que el llamante borra cuando todo lo demás haya salido bien
    /// (o restaura con `force_path` si no). Nunca pisa un fichero que ya exista en `new`.
    pub fn relocate(&self, new: PathBuf) -> Result<PathBuf> {
        let guard = self.inner.lock().unwrap();
        if guard.is_none() {
            return Err(AppError::Locked);
        }
        let old = self.path();
        if new == old {
            return Err(AppError::msg("dataSamePlace"));
        }
        if new.exists() {
            return Err(AppError::msg_arg("dataTargetExists", new.display().to_string()));
        }
        if let Some(dir) = new.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = new.with_extension("tmp");
        fs::copy(&old, &tmp)?;
        if fs::read(&old)? != fs::read(&tmp)? {
            let _ = fs::remove_file(&tmp);
            return Err(AppError::msg("dataCopyFailed"));
        }
        fs::rename(&tmp, &new)?;
        *self.path.lock().unwrap() = new;
        Ok(old)
    }

    /// Deshace un `relocate` cuyo resto de pasos falló.
    pub fn force_path(&self, path: PathBuf) {
        *self.path.lock().unwrap() = path;
    }

    pub fn read<R>(&self, f: impl FnOnce(&Data) -> R) -> Result<R> {
        let guard = self.inner.lock().unwrap();
        Ok(f(&guard.as_ref().ok_or(AppError::Locked)?.data))
    }

    /// Muta una copia y la persiste; solo si el guardado tiene éxito se sustituye el estado en memoria.
    pub fn write<R>(&self, f: impl FnOnce(&mut Data) -> Result<R>) -> Result<R> {
        let mut guard = self.inner.lock().unwrap();
        let st = guard.as_mut().ok_or(AppError::Locked)?;
        // Primero lo que otro equipo haya guardado: el cambio se aplica encima y no lo pisa.
        self.refresh(st)?;
        let mut data = st.data.clone();
        let out = f(&mut data)?;
        data.stamp();
        st.sig = self.save(&st.keys, &data)?;
        st.data = data;
        Ok(out)
    }

    pub fn change_password(&self, new_password: &str) -> Result<()> {
        if new_password.is_empty() {
            return Err(AppError::msg("masterEmpty"));
        }
        let mut guard = self.inner.lock().unwrap();
        let st = guard.as_mut().ok_or(AppError::Locked)?;
        self.refresh(st)?;
        let keys = Keys::new(new_password, self.cost)?;
        let mut data = st.data.clone();
        data.stamp();
        st.sig = self.save(&keys, &data)?;
        st.data = data;
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
    fn seal_is_openable_with_the_master_password_and_needs_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::with_cost(dir.path().join("vaults.enc"), FAST);
        assert!(matches!(s.seal(b"x"), Err(AppError::Locked)));
        s.unlock("maestra").unwrap();
        let blob = s.seal(b"contenido").unwrap();
        let (_, plain) = Keys::decrypt("maestra", &blob).unwrap();
        assert_eq!(&plain[..], b"contenido");
        assert!(matches!(Keys::decrypt("otra", &blob), Err(AppError::WrongPassword)));
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

    #[test]
    fn relocate_copies_verifies_and_keeps_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("a").join("vaults.enc");
        let s = Store::with_cost(old.clone(), FAST);
        assert!(matches!(s.relocate(dir.path().join("x.enc")), Err(AppError::Locked)));
        s.unlock("m").unwrap();
        s.write(|d| {
            d.vaults.push(vault("uno"));
            Ok(())
        })
        .unwrap();

        let new = dir.path().join("b").join("vaults.enc");
        assert_eq!(s.relocate(new.clone()).unwrap(), old);
        assert_eq!(s.path(), new);
        assert!(new.is_file() && old.is_file(), "el llamante borra el antiguo");
        assert!(s.is_unlocked());
        s.write(|d| {
            d.vaults.push(vault("dos"));
            Ok(())
        })
        .unwrap();
        assert!(!new.with_extension("tmp").exists());

        // Abrir el nuevo fichero con la misma contraseña ve ambos clientes; el antiguo no ve el segundo.
        let again = Store::with_cost(new.clone(), FAST);
        again.unlock("m").unwrap();
        assert_eq!(again.read(|d| d.vaults.len()).unwrap(), 2);

        // No pisa un fichero existente ni se mueve a sí mismo.
        assert!(matches!(s.relocate(old.clone()), Err(AppError::Msg { code: "dataTargetExists", .. })));
        assert!(matches!(s.relocate(new), Err(AppError::Msg { code: "dataSamePlace", .. })));
    }

    #[test]
    fn set_path_needs_the_app_locked_and_switches_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.enc");
        let b = dir.path().join("b.enc");
        let s = Store::with_cost(a.clone(), FAST);
        s.unlock("una").unwrap();
        assert!(matches!(s.set_path(b.clone()), Err(AppError::Msg { code: "dataUnlockFirst", .. })));
        s.lock();
        s.set_path(b.clone()).unwrap();
        assert!(!s.exists(), "el otro fichero aún no existe: primer uso");
        s.unlock("otra").unwrap();
        assert!(a.is_file() && b.is_file());
        s.lock();
        s.set_path(a).unwrap();
        assert!(matches!(s.unlock("otra"), Err(AppError::WrongPassword)), "cada fichero con su contraseña");
        s.unlock("una").unwrap();
    }

    #[test]
    fn two_devices_share_one_file_without_overwriting_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let a = Store::with_cost(path.clone(), FAST);
        a.unlock("m").unwrap();
        let b = Store::with_cost(path.clone(), FAST);
        b.unlock("m").unwrap();

        b.write(|d| {
            d.vaults.push(vault("de-b"));
            Ok(())
        })
        .unwrap();
        // A aún no lo ha visto; al recoger los cambios sí.
        assert_eq!(a.read(|d| d.vaults.len()).unwrap(), 0);
        assert!(a.sync().unwrap());
        assert!(!a.sync().unwrap(), "sin cambios nuevos no hay nada que recoger");
        assert_eq!(a.read(|d| d.vaults.len()).unwrap(), 1);

        // Si A no sincroniza y escribe, su cambio se aplica encima del de B en lugar de pisarlo.
        b.write(|d| {
            d.vaults.push(vault("de-b-2"));
            Ok(())
        })
        .unwrap();
        a.write(|d| {
            d.vaults.push(vault("de-a"));
            Ok(())
        })
        .unwrap();
        let names = |s: &Store| s.read(|d| d.vaults.iter().map(|v| v.client.clone()).collect::<Vec<_>>()).unwrap();
        assert_eq!(names(&a), ["de-b", "de-b-2", "de-a"]);
        assert!(b.sync().unwrap());
        assert_eq!(names(&b), ["de-b", "de-b-2", "de-a"]);

        // Si otro equipo cambia la contraseña maestra, éste debe volver a desbloquear.
        b.change_password("nueva").unwrap();
        assert!(matches!(a.sync(), Err(AppError::Msg { code: "dataKeyChanged", .. })));
        assert!(matches!(a.write(|_| Ok(())), Err(AppError::Msg { code: "dataKeyChanged", .. })));
        a.lock();
        assert!(matches!(a.unlock("m"), Err(AppError::WrongPassword)));
        a.unlock("nueva").unwrap();
        assert_eq!(a.read(|d| d.vaults.len()).unwrap(), 3);
    }

    #[test]
    fn newer_files_ask_to_update_and_are_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let keys = Keys::new("m", FAST).unwrap();
        let newer = br#"{"format":2,"min_app":"9.9.0","vaults":[]}"#;
        let blob = keys.encrypt(newer).unwrap();
        fs::write(&path, &blob).unwrap();

        let s = Store::with_cost(path.clone(), FAST);
        assert!(matches!(s.unlock("m"), Err(AppError::Msg { code: "dataNewer", ref arg }) if arg == "9.9.0"));
        assert!(!s.is_unlocked());
        assert_eq!(fs::read(&path).unwrap(), blob, "no se ha modificado el fichero");
        // Con la contraseña equivocada sigue siendo un error de contraseña, no de versión.
        assert!(matches!(s.unlock("x"), Err(AppError::WrongPassword)));
    }

    #[test]
    fn unknown_fields_from_a_newer_minor_version_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults.enc");
        let keys = Keys::new("m", FAST).unwrap();
        let json = br#"{"format":1,"futuro":{"x":1},"vaults":[{"id":"1","client":"A","path":"a.kdbx","keyfile":null,"password":null,"color":"rojo"}]}"#;
        fs::write(&path, keys.encrypt(json).unwrap()).unwrap();

        let s = Store::with_cost(path.clone(), FAST);
        s.unlock("m").unwrap();
        s.write(|d| {
            d.vaults[0].favorite = true;
            Ok(())
        })
        .unwrap();
        s.lock();

        let (_, plain) = Keys::decrypt("m", &fs::read(&path).unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(v["futuro"]["x"], 1);
        assert_eq!(v["vaults"][0]["color"], "rojo");
        assert_eq!(v["vaults"][0]["favorite"], true);
        assert_eq!(v["written_by"], env!("CARGO_PKG_VERSION"));
    }
}
