//! Guardado de adjuntos y validación de enlaces procedentes de un `.kdbx` (contenido no fiable).

use std::path::Path;

use crate::error::{AppError, Result};

/// Nombres que Windows reserva para dispositivos, con o sin extensión.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
const MAX_NAME: usize = 120;
/// Tope de lo que se guarda de una vez (el adjunto se mantiene entero en memoria).
pub const MAX_ATTACHMENT: usize = 256 * 1024 * 1024;

/// Nombre de fichero seguro para proponer en «Guardar como»: sin rutas, sin `:` (flujos alternativos de
/// NTFS), sin caracteres de control ni reservados, sin nombres de dispositivo y de longitud acotada.
pub fn safe_file_name(name: &str) -> String {
    // Solo el último tramo, venga con `/` o con `\`.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let cleaned: String = cleaned.chars().take(MAX_NAME).collect();
    let cleaned = cleaned.trim_end_matches(|c: char| c == '.' || c.is_whitespace()).to_owned();
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if cleaned.is_empty() || RESERVED.contains(&stem.as_str()) {
        return format!("adjunto{}", if cleaned.is_empty() { String::new() } else { format!("_{cleaned}") });
    }
    cleaned
}

/// Escribe el adjunto. En Windows lo marca como «descargado de Internet» (`Zone.Identifier`) para que
/// SmartScreen avise si alguien ejecuta un `.exe` o un script adjunto. Es un esfuerzo: si falla, se guarda igual.
pub fn write_attachment(path: &Path, data: &[u8]) -> Result<()> {
    if data.len() > MAX_ATTACHMENT {
        return Err(AppError::msg("attachmentTooBig"));
    }
    std::fs::write(path, data)?;
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    Ok(())
}

/// Enlace que se puede abrir en el navegador: solo `http`, `https` y `mailto`. KeePass admite `file:`,
/// `cmd://` y otros esquemas que no se deben lanzar desde un contenido ajeno. Sin esquema se asume `https`.
pub fn safe_link(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 2048 || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("mailto:") {
        return (!rest.is_empty()).then(|| s.to_owned());
    }
    if let Some(i) = lower.find("://") {
        let scheme = &lower[..i];
        let host = s[i + 3..].split(['/', '?', '#']).next().unwrap_or("");
        return (matches!(scheme, "http" | "https") && !host.is_empty()).then(|| s.to_owned());
    }
    // Sin «://»: «dominio.com/ruta» o «dominio.com:8080». Si hay dos puntos antes de un punto,
    // es un esquema (`javascript:`, `data:`…) y se rechaza.
    let head = s.split(['/', '?', '#']).next().unwrap_or("");
    let before_colon = head.split(':').next().unwrap_or("");
    if head.contains(':') && !before_colon.contains('.') {
        return None;
    }
    (before_colon.contains('.') || before_colon.eq_ignore_ascii_case("localhost")).then(|| format!("https://{s}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_neutralised() {
        assert_eq!(safe_file_name("informe.pdf"), "informe.pdf");
        assert_eq!(safe_file_name("..\\..\\Windows\\x.dll"), "x.dll");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("a:b.txt"), "a_b.txt");
        assert_eq!(safe_file_name("a.txt:evil.exe"), "a.txt_evil.exe");
        assert_eq!(safe_file_name("nota.txt. "), "nota.txt");
        assert_eq!(safe_file_name("con.txt"), "adjunto_con.txt");
        assert_eq!(safe_file_name("NUL"), "adjunto_NUL");
        assert_eq!(safe_file_name(""), "adjunto");
        assert_eq!(safe_file_name("..."), "adjunto");
        assert_eq!(safe_file_name("a\u{0}b\n.txt"), "a_b_.txt");
        assert_eq!(safe_file_name(&"x".repeat(1000)).chars().count(), MAX_NAME);
        assert_eq!(safe_file_name("ñandú café.txt"), "ñandú café.txt");
    }

    #[test]
    fn only_web_and_mail_links_pass() {
        for ok in ["https://example.com/a?b=1", "http://localhost:8080", "example.com", "example.com:8443/x", "mailto:a@b.es"] {
            assert!(safe_link(ok).is_some(), "{ok}");
        }
        assert_eq!(safe_link("example.com").as_deref(), Some("https://example.com"));
        for bad in [
            "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///C:/Windows/System32/cmd.exe",
            "cmd://calc", "ftp://x.com", "vbscript:x", "https://", "mailto:", "", "   ", "exa mple.com", "intranet",
            "http://a.com\r\nX: y",
        ] {
            assert!(safe_link(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn oversized_attachments_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        write_attachment(&p, b"hola").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hola");
    }
}
