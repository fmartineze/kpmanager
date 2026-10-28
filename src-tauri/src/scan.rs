use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Candidate {
    /// Nombre de la carpeta que contiene el `.kdbx`.
    pub client: String,
    pub path: PathBuf,
    /// Ya registrado en la aplicación.
    pub already: bool,
    /// Descartado antes en una revisión de carpetas en seguimiento (lo rellena el comando).
    #[serde(default)]
    pub ignored: bool,
}

/// Clave comparable de una ruta: mismo fichero escrito de distinta forma (mayúsculas,
/// `/` frente a `\`, prefijo `\?\`, barra final) produce la misma clave en Windows.
pub fn path_key(p: &Path) -> String {
    let mut s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s = s.replace('\\', "/").to_lowercase();
        if let Some(rest) = s.strip_prefix("//?/") {
            s = rest.to_owned();
        }
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// `child` está dentro de `root` (comparación por claves).
pub fn is_under(child: &Path, root: &Path) -> bool {
    let (c, r) = (path_key(child), path_key(root));
    c.len() > r.len() && c.starts_with(&r) && (r.ends_with('/') || c.as_bytes()[r.len()] == b'/')
}

pub fn scan_dir(root: &Path, existing: &HashSet<String>) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("kdbx"))
        })
        .map(|e| {
            let path = e.into_path();
            let client = path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let already = existing.contains(&path_key(&path));
            Candidate { client, path, already, ignored: false }
        })
        .collect();
    out.sort_by(|a, b| {
        a.client.to_lowercase().cmp(&b.client.to_lowercase()).then_with(|| a.path.cmp(&b.path))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn maps_folder_name_to_client() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("ClienteA");
        let b = dir.path().join("grupo").join("ClienteB");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("claves.kdbx"), b"").unwrap();
        fs::write(b.join("otras.KDBX"), b"").unwrap();
        fs::write(b.join("notas.txt"), b"").unwrap();

        let mut existing = HashSet::new();
        existing.insert(path_key(&a.join("claves.kdbx")));
        let found = scan_dir(dir.path(), &existing);

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].client, "ClienteA");
        assert!(found[0].already);
        assert_eq!(found[1].client, "ClienteB");
        assert!(!found[1].already);
    }

    #[test]
    fn path_key_and_is_under() {
        assert!(is_under(Path::new("/a/b/c.kdbx"), Path::new("/a/b")));
        assert!(is_under(Path::new("/a/b/c.kdbx"), Path::new("/a/b/")));
        assert!(!is_under(Path::new("/a/bc/c.kdbx"), Path::new("/a/b")));
        assert!(!is_under(Path::new("/a/b"), Path::new("/a/b")));
        #[cfg(windows)]
        assert_eq!(path_key(Path::new(r"C:\Datos\X.kdbx")), path_key(Path::new("c:/datos/x.kdbx")));
    }
}
