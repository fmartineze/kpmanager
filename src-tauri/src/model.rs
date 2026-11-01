use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

/// Comando para lanzar KeePassXC: `program` más argumentos previos
/// (p. ej. `flatpak run org.keepassxc.KeePassXC`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Executable {
    pub program: PathBuf,
    #[serde(default)]
    pub args_prefix: Vec<String>,
}

impl Executable {
    pub fn from_program(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), args_prefix: Vec::new() }
    }

    pub fn display(&self) -> String {
        let mut s = self.program.to_string_lossy().into_owned();
        for a in &self.args_prefix {
            s.push(' ');
            s.push_str(a);
        }
        s
    }
}

// Nota: serde serializa `PathBuf` solo si es UTF-8 válido; rutas no UTF-8 (Linux) no se soportan.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Vault {
    pub id: String,
    pub client: String,
    pub path: PathBuf,
    pub keyfile: Option<PathBuf>,
    pub password: Option<Zeroizing<String>>,
    #[serde(default)]
    pub favorite: bool,
    /// Etiquetas para agrupar y filtrar clientes («Hosting», «Contabilidad»…).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Segundos desde la época Unix de la última apertura desde la app.
    #[serde(default)]
    pub last_opened: Option<u64>,
    /// Abrir siempre directamente en KeePassXC, sin la vista dentro de la app.
    #[serde(default)]
    pub open_external: bool,
    /// Campos que esta versión no conoce (los añadió una más nueva): se conservan al volver a guardar.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub keepassxc: Option<Executable>,
    /// Keyfile que se ofrece al crear o editar un vault.
    #[serde(default)]
    pub default_keyfile: Option<PathBuf>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Versión del esquema del fichero de datos que entiende esta versión de la app.
///
/// Se sube solo cuando un cambio **no** se puede leer con las versiones anteriores (renombrar o cambiar el
/// significado de un campo). Añadir campos nuevos no lo requiere: se ignoran y se conservan (`extra`). Quien
/// suba este número debe rellenar `min_app` con la primera versión de la app que lo entiende, para que las
/// anteriores muestren «actualiza la aplicación» en vez de un error.
pub const DATA_FORMAT: u32 = 1;

/// Versión de la app que escribe el fichero.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn legacy_format() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Data {
    /// Esquema del fichero. Los ficheros anteriores a este campo son el 1.
    #[serde(default = "legacy_format")]
    pub format: u32,
    /// Primera versión de la app capaz de leer este fichero (solo si hubo un cambio incompatible).
    #[serde(default)]
    pub min_app: Option<String>,
    /// Última versión de la app que lo guardó (informativo).
    #[serde(default)]
    pub written_by: Option<String>,
    #[serde(default)]
    pub vaults: Vec<Vault>,
    #[serde(default)]
    pub settings: Settings,
    /// Carpetas en seguimiento: se revisan en busca de vaults nuevos o desaparecidos.
    #[serde(default)]
    pub watched: Vec<PathBuf>,
    /// Vaults detectados que el usuario decidió no añadir; no se vuelve a preguntar.
    #[serde(default)]
    pub ignored: Vec<PathBuf>,
    /// Campos de versiones más nuevas que esta no conoce: se conservan al guardar.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            format: DATA_FORMAT,
            min_app: None,
            written_by: None,
            vaults: Vec::new(),
            settings: Settings::default(),
            watched: Vec::new(),
            ignored: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl Data {
    /// Marca el fichero como escrito por esta versión.
    pub fn stamp(&mut self) {
        self.written_by = Some(APP_VERSION.into());
    }

    /// Lee los datos descifrados. Un fichero de un esquema más nuevo se rechaza con `dataNewer` (y la versión
    /// mínima que lo entiende, si consta): abrirlo y volver a guardarlo podría estropearlo.
    pub fn parse(plain: &[u8]) -> crate::error::Result<Data> {
        #[derive(Deserialize)]
        struct Probe {
            format: Option<u32>,
            min_app: Option<String>,
        }
        let probe: Probe = serde_json::from_slice(plain)?;
        if probe.format.unwrap_or(1) > DATA_FORMAT {
            return Err(crate::error::AppError::msg_arg("dataNewer", probe.min_app.unwrap_or_default()));
        }
        let mut data: Data = serde_json::from_slice(plain)?;
        data.migrate();
        Ok(data)
    }

    /// Lleva a los datos de un esquema anterior al actual. Hoy solo existe el 1.
    fn migrate(&mut self) {
        self.format = DATA_FORMAT;
    }
}

pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_LEN: usize = 32;

/// Limpia las etiquetas que llegan de la interfaz: recorta espacios, quita `#` inicial, descarta vacías,
/// elimina duplicados sin distinguir mayúsculas (se conserva la primera grafía) y limita número y longitud.
pub fn normalize_tags(raw: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for t in raw {
        let t = t.trim().trim_start_matches('#');
        let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
        let t: String = t.chars().take(MAX_TAG_LEN).collect::<String>().trim().to_owned();
        if t.is_empty() || !seen.insert(t.to_lowercase()) {
            continue;
        }
        out.push(t);
        if out.len() == MAX_TAGS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(v: &[&str]) -> Vec<String> {
        normalize_tags(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn trims_collapses_and_drops_empty() {
        assert_eq!(n(&["  Hosting ", "#Conta  bilidad", "", "   ", "#"]), ["Hosting", "Conta bilidad"]);
    }

    #[test]
    fn dedupes_ignoring_case_keeping_first_spelling() {
        assert_eq!(n(&["Hosting", "hosting", "HOSTING", "Web"]), ["Hosting", "Web"]);
        assert_eq!(n(&["Ñandú", "ñandú"]), ["Ñandú"], "también con acentos y ñ");
    }

    #[test]
    fn limits_count_and_length() {
        let many: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
        assert_eq!(normalize_tags(many).len(), MAX_TAGS);
        let long = "x".repeat(100);
        assert_eq!(n(&[long.as_str()])[0].chars().count(), MAX_TAG_LEN);
        assert_eq!(n(&["añadir ".repeat(10).as_str()])[0].chars().count() <= MAX_TAG_LEN, true, "no corta por bytes");
    }

    #[test]
    fn newer_schema_is_refused_and_unknown_fields_survive() {
        // Un fichero sin «format» (anterior a este campo) es el esquema 1.
        let old = br#"{"vaults":[{"id":"1","client":"A","path":"a.kdbx","keyfile":null,"password":null}]}"#;
        let d = Data::parse(old).unwrap();
        assert_eq!((d.format, d.vaults.len()), (1, 1));

        // Campos desconocidos (de una versión más nueva, pero compatible) se conservan al reescribir.
        let newer_minor = br#"{"format":1,"futuro":{"x":1},"vaults":[{"id":"1","client":"A","path":"a.kdbx","keyfile":null,"password":null,"color":"rojo"}]}"#;
        let d = Data::parse(newer_minor).unwrap();
        let again = serde_json::to_value(&d).unwrap();
        assert_eq!(again["futuro"]["x"], 1);
        assert_eq!(again["vaults"][0]["color"], "rojo");

        // Un esquema más nuevo no se abre: se pide actualizar, con la versión mínima si consta.
        let newer = br#"{"format":2,"min_app":"9.0.0","vaults":[]}"#;
        assert!(matches!(Data::parse(newer), Err(crate::error::AppError::Msg { code: "dataNewer", ref arg }) if arg == "9.0.0"));
        let no_min = br#"{"format":7}"#;
        assert!(matches!(Data::parse(no_min), Err(crate::error::AppError::Msg { code: "dataNewer", ref arg }) if arg.is_empty()));
    }
}
