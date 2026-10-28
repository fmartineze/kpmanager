use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("La aplicación está bloqueada")]
    Locked,
    #[error("Contraseña maestra incorrecta")]
    WrongPassword,
    #[error("Fichero de configuración corrupto o con formato desconocido")]
    BadFormat,
    #[error("Error de cifrado: {0}")]
    Crypto(String),
    #[error("Error de E/S: {0}")]
    Io(#[from] std::io::Error),
    #[error("Error de serialización: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Vault no encontrado")]
    NotFound,
    #[error("No se encontró KeePassXC. Configura su ruta en Ajustes")]
    KeePassNotFound,
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
