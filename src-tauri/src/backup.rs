//! Exportar e importar la configuración completa en un único fichero cifrado.
//!
//! El fichero es un `Keys::encrypt` (el mismo formato que `vaults.enc`) de un JSON con los datos y las
//! preferencias. Se cifra con la contraseña maestra de la sesión y se abre con la contraseña maestra
//! con la que se exportó, que puede ser distinta de la actual (otro equipo).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::model::Data;
use crate::prefs::Prefs;
use crate::scan::path_key;

const KIND: &str = "kpmanager-export";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct Export {
    kind: String,
    version: u32,
    pub data: Data,
    pub prefs: Prefs,
}

pub fn pack(data: &Data, prefs: &Prefs) -> Result<Zeroizing<Vec<u8>>> {
    let export = Export { kind: KIND.into(), version: VERSION, data: data.clone(), prefs: prefs.clone() };
    Ok(Zeroizing::new(serde_json::to_vec(&export)?))
}

pub fn unpack(plain: &[u8]) -> Result<Export> {
    // Un descifrado correcto con contenido que no es nuestro JSON también es «no es una exportación».
    let export: Export = serde_json::from_slice(plain).map_err(|_| AppError::msg("notExport"))?;
    if export.kind != KIND {
        return Err(AppError::msg("notExport"));
    }
    if export.version > VERSION {
        return Err(AppError::msg_arg("exportVersion", export.version.to_string()));
    }
    Ok(export)
}

#[derive(Debug, Default, PartialEq)]
pub struct Added {
    pub vaults: usize,
    pub folders: usize,
}

/// Añade a `current` lo que trae `incoming` y aún no existe (por ruta). No modifica nada de lo existente,
/// salvo rellenar la ruta de KeePassXC y la keyfile predeterminada si estaban vacías.
pub fn merge(current: &mut Data, incoming: &Data) -> Added {
    let mut added = Added::default();

    let mut known: HashSet<String> = current.vaults.iter().map(|v| path_key(&v.path)).collect();
    let mut ids: HashSet<String> = current.vaults.iter().map(|v| v.id.clone()).collect();
    for v in &incoming.vaults {
        if !known.insert(path_key(&v.path)) {
            continue;
        }
        let mut v = v.clone();
        if !ids.insert(v.id.clone()) {
            v.id = uuid::Uuid::new_v4().to_string();
            ids.insert(v.id.clone());
        }
        current.vaults.push(v);
        added.vaults += 1;
    }

    let mut watched: HashSet<String> = current.watched.iter().map(|p| path_key(p)).collect();
    for w in &incoming.watched {
        if watched.insert(path_key(w)) {
            current.watched.push(w.clone());
            added.folders += 1;
        }
    }

    let mut ignored: HashSet<String> = current.ignored.iter().map(|p| path_key(p)).collect();
    for i in &incoming.ignored {
        if ignored.insert(path_key(i)) {
            current.ignored.push(i.clone());
        }
    }

    if current.settings.keepassxc.is_none() {
        current.settings.keepassxc = incoming.settings.keepassxc.clone();
    }
    if current.settings.default_keyfile.is_none() {
        current.settings.default_keyfile = incoming.settings.default_keyfile.clone();
    }
    added
}

/// Tras sustituirlo todo, una ruta de KeePassXC que no existe en este equipo se descarta (autodetección).
pub fn sanitize_for_this_machine(data: &mut Data) {
    if data.settings.keepassxc.as_ref().is_some_and(|e| !e.program.is_file()) {
        data.settings.keepassxc = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Executable, Vault};

    fn vault(id: &str, path: &str) -> Vault {
        Vault { id: id.into(), client: id.into(), path: path.into(), ..Default::default() }
    }

    #[test]
    fn pack_unpack_roundtrip_keeps_credentials() {
        let mut data = Data::default();
        let mut v = vault("a", "/x/a.kdbx");
        v.password = Some(Zeroizing::new("secreto".into()));
        data.vaults.push(v);
        let plain = pack(&data, &Prefs::default()).unwrap();
        let back = unpack(&plain).unwrap();
        assert_eq!(back.data.vaults.len(), 1);
        assert_eq!(back.data.vaults[0].password.as_deref().map(String::as_str), Some("secreto"));
    }

    #[test]
    fn export_from_one_machine_imports_into_another_with_a_different_master_password() {
        use crate::crypto::{KdfCost, Keys};
        use crate::store::Store;
        const FAST: KdfCost = KdfCost { m_kib: 8, t: 1, p: 1 };
        let dir = tempfile::tempdir().unwrap();

        // Equipo A: contraseña maestra «A», un vault con contraseña guardada.
        let a = Store::with_cost(dir.path().join("a.enc"), FAST);
        a.unlock("A").unwrap();
        a.write(|d| {
            let mut v = vault("1", "/c/Acme/claves.kdbx");
            v.password = Some(Zeroizing::new("secreto".into()));
            d.vaults.push(v);
            d.watched.push("/c".into());
            Ok(())
        })
        .unwrap();
        let file = a.seal(&pack(&a.read(|d| d.clone()).unwrap(), &Prefs::default()).unwrap()).unwrap();
        assert!(!String::from_utf8_lossy(&file).contains("secreto"), "el fichero exportado no lleva nada en claro");

        // Equipo B: otra contraseña maestra, con un vault propio.
        let b = Store::with_cost(dir.path().join("b.enc"), FAST);
        b.unlock("B").unwrap();
        b.write(|d| { d.vaults.push(vault("9", "/d/Propio/claves.kdbx")); Ok(()) }).unwrap();

        assert!(matches!(Keys::decrypt("B", &file), Err(AppError::WrongPassword)), "la contraseña de B no abre el fichero de A");
        let (_, plain) = Keys::decrypt("A", &file).unwrap();
        let incoming = unpack(&plain).unwrap();
        let added = b.write(|d| Ok(merge(d, &incoming.data))).unwrap();

        assert_eq!(added, Added { vaults: 1, folders: 1 });
        assert_eq!(b.read(|d| d.vaults.len()).unwrap(), 2, "conserva el suyo y añade el importado");
        let pw = b.read(|d| d.vaults.iter().find(|v| v.id == "1").and_then(|v| v.password.as_ref().map(|p| p.to_string()))).unwrap();
        assert_eq!(pw.as_deref(), Some("secreto"), "la contraseña guardada viaja con el vault");
    }

    #[test]
    fn rejects_foreign_content_and_newer_versions() {
        assert!(matches!(unpack(b"{\"hola\":1}"), Err(AppError::Msg { code: "notExport", .. })));
        assert!(matches!(unpack(b"no es json"), Err(AppError::Msg { code: "notExport", .. })));
        let mut e = serde_json::to_value(Export { kind: KIND.into(), version: 1, data: Data::default(), prefs: Prefs::default() }).unwrap();
        e["version"] = 99.into();
        assert!(matches!(unpack(&serde_json::to_vec(&e).unwrap()), Err(AppError::Msg { code: "exportVersion", .. })));
    }

    #[test]
    fn merge_adds_only_what_is_missing() {
        let mut cur = Data::default();
        cur.vaults.push(vault("1", "/c/Acme/claves.kdbx"));
        cur.watched.push("/c".into());

        let mut inc = Data::default();
        inc.vaults.push(vault("1", "/c/Otro/claves.kdbx")); // mismo id, otra ruta → id nuevo
        inc.vaults.push(vault("2", "/c/Acme/claves.kdbx")); // misma ruta → se omite
        inc.vaults.push(vault("3", "/c/Beta/claves.kdbx"));
        inc.watched = vec!["/c".into(), "/d".into()];
        inc.ignored.push("/c/x.kdbx".into());
        inc.settings.default_keyfile = Some("/k.key".into());

        let added = merge(&mut cur, &inc);
        assert_eq!(added, Added { vaults: 2, folders: 1 });
        assert_eq!(cur.vaults.len(), 3);
        let ids: HashSet<_> = cur.vaults.iter().map(|v| v.id.clone()).collect();
        assert_eq!(ids.len(), 3, "los ids no se repiten");
        assert_eq!(cur.watched.len(), 2);
        assert_eq!(cur.ignored.len(), 1);
        assert_eq!(cur.settings.default_keyfile.as_deref().and_then(|p| p.to_str()), Some("/k.key"));
    }

    #[test]
    fn merge_does_not_overwrite_existing_settings() {
        let mut cur = Data::default();
        cur.settings.default_keyfile = Some("/mia.key".into());
        let mut inc = Data::default();
        inc.settings.default_keyfile = Some("/otra.key".into());
        merge(&mut cur, &inc);
        assert_eq!(cur.settings.default_keyfile.as_deref().and_then(|p| p.to_str()), Some("/mia.key"));
    }

    #[test]
    fn sanitize_drops_missing_keepassxc_path() {
        let mut d = Data::default();
        d.settings.keepassxc = Some(Executable::from_program("/no/existe/keepassxc"));
        sanitize_for_this_machine(&mut d);
        assert!(d.settings.keepassxc.is_none());
    }
}
