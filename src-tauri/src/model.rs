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
