use std::path::PathBuf;

use serde::{Deserialize, Serialize};
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
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub keepassxc: Option<Executable>,
    /// Keyfile que se ofrece al crear o editar un vault.
    #[serde(default)]
    pub default_keyfile: Option<PathBuf>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Data {
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
}
