//! Lectura (solo lectura) de un `.kdbx` para navegarlo desde la app.
//!
//! El contenido del fichero se trata como hostil: puede venir de un tercero. Aquí se acotan el tamaño,
//! los parámetros de derivación de clave y los iconos, y el árbol que sale hacia la interfaz **no lleva
//! contraseñas, notas ni semillas TOTP**: esos datos se piden uno a uno y bajo demanda.

use std::collections::HashMap;
use std::fs::File;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use keepass::DatabaseKey;
use keepass::db::{Database, EntryId, EntryRef, GroupId, Icon, fields};
use keepass::error::DatabaseOpenError;
use serde::Serialize;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::model::Vault;

/// Un `.kdbx` mayor que esto se rechaza (los reales pesan KB o pocos MB).
const MAX_FILE: u64 = 256 * 1024 * 1024;
/// Techos de la función de derivación de clave que declara el fichero. Un `.kdbx` hostil podría pedir
/// gigas de memoria o años de cálculo; los valores habituales de KeePassXC quedan muy por debajo.
const MAX_KDF_MEMORY: u64 = 1 << 30;
const MAX_KDF_ITERATIONS: u64 = 1_000;
const MAX_KDF_PARALLELISM: u32 = 64;
const MAX_AES_ROUNDS: u64 = 200_000_000;
/// Iconos personalizados: se descarta lo que exceda estos límites.
const MAX_ICON_BYTES: usize = 64 * 1024;
const MAX_ICON_SIDE: u32 = 1024;
const MAX_ICONS: usize = 200;
/// Recortes defensivos de los textos que viajan a la interfaz.
const MAX_ROW_TEXT: usize = 256;
const MAX_FIELD_TEXT: usize = 8 * 1024;
const MAX_NOTES: usize = 256 * 1024;

const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

// ───────────────────────── Apertura ─────────────────────────

/// Cabecera KDBX: comprueba los parámetros de la KDF antes de gastar memoria o CPU en descifrar.
fn check_kdf(data: &[u8]) -> Result<()> {
    let bad = || AppError::msg("vaultCorrupt");
    let heavy = || AppError::msg("vaultTooHeavy");
    let u16_at = |i: usize| data.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |i: usize| data.get(i..i + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
    let u64_at = |i: usize| data.get(i..i + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()));

    // Firma (8 bytes) + versión: menor u16, mayor u16.
    let Some(major) = u16_at(10) else { return Err(bad()) };
    match major {
        3 => {
            // Campos: id u8, tamaño u16. El 6 es TransformRounds (u64). El 0 cierra la cabecera.
            let mut p = 12;
            loop {
                let id = *data.get(p).ok_or_else(bad)?;
                let len = u16_at(p + 1).ok_or_else(bad)? as usize;
                p += 3;
                if id == 6 {
                    if len != 8 || u64_at(p).ok_or_else(bad)? > MAX_AES_ROUNDS {
                        return Err(heavy());
                    }
                }
                if id == 0 {
                    return Ok(());
                }
                p = p.checked_add(len).ok_or_else(bad)?;
            }
        }
        4 => {
            // Campos: id u8, tamaño u32. El 11 es KdfParameters (diccionario de variantes).
            let mut p = 12;
            loop {
                let id = *data.get(p).ok_or_else(bad)?;
                let len = u32_at(p + 1).ok_or_else(bad)? as usize;
                p += 5;
                let end = p.checked_add(len).ok_or_else(bad)?;
                if id == 11 {
                    return check_variant_dict(data.get(p..end).ok_or_else(bad)?);
                }
                if id == 0 {
                    return Ok(());
                }
                p = end;
            }
        }
        // KDB 1.x u otras: que decida el crate (rechaza lo que no soporta).
        _ => Ok(()),
    }
}

fn check_variant_dict(d: &[u8]) -> Result<()> {
    let bad = || AppError::msg("vaultCorrupt");
    let heavy = || AppError::msg("vaultTooHeavy");
    let mut p = 2; // versión del diccionario
    loop {
        let ty = *d.get(p).ok_or_else(bad)?;
        if ty == 0 {
            return Ok(());
        }
        let klen = u32::from_le_bytes(d.get(p + 1..p + 5).ok_or_else(bad)?.try_into().unwrap()) as usize;
        let kstart = p + 5;
        let key = d.get(kstart..kstart.checked_add(klen).ok_or_else(bad)?).ok_or_else(bad)?;
        let vp = kstart + klen;
        let vlen = u32::from_le_bytes(d.get(vp..vp + 4).ok_or_else(bad)?.try_into().unwrap()) as usize;
        let vstart = vp + 4;
        let val = d.get(vstart..vstart.checked_add(vlen).ok_or_else(bad)?).ok_or_else(bad)?;
        let num = |b: &[u8]| -> Option<u64> {
            match b.len() {
                4 => Some(u32::from_le_bytes(b.try_into().ok()?) as u64),
                8 => Some(u64::from_le_bytes(b.try_into().ok()?)),
                _ => None,
            }
        };
        let limit = match key {
            b"M" => Some(MAX_KDF_MEMORY),
            b"I" => Some(MAX_KDF_ITERATIONS),
            b"P" => Some(MAX_KDF_PARALLELISM as u64),
            b"R" => Some(MAX_AES_ROUNDS),
            _ => None,
        };
        if let Some(limit) = limit {
            if num(val).ok_or_else(bad)? > limit {
                return Err(heavy());
            }
        }
        p = vstart + vlen;
    }
}

fn map_open_error(e: DatabaseOpenError) -> AppError {
    use keepass::error::DatabaseKeyError as K;
    match e {
        DatabaseOpenError::Key(K::IncorrectKey) => AppError::msg("vaultWrongKey"),
        DatabaseOpenError::Key(K::EmptyKey) => AppError::msg("vaultNoCredentials"),
        DatabaseOpenError::Key(K::Io(_)) => AppError::msg("vaultKeyfile"),
        DatabaseOpenError::Key(_) => AppError::msg("vaultKeyfile"),
        DatabaseOpenError::Io(e) => AppError::Io(e),
        DatabaseOpenError::UnsupportedVersion => AppError::msg("vaultUnsupported"),
        // Nada del mensaje original: podría arrastrar contenido del fichero.
        _ => AppError::msg("vaultCorrupt"),
    }
}

/// Abre el vault con las credenciales guardadas. No escribe nunca en el fichero.
pub fn open(vault: &Vault) -> Result<Database> {
    let has_password = vault.password.as_ref().is_some_and(|p| !p.is_empty());
    if !has_password && vault.keyfile.is_none() {
        return Err(AppError::msg("vaultNoCredentials"));
    }
    let meta = std::fs::metadata(&vault.path).map_err(|_| AppError::msg_arg("fileMissing", vault.path.display().to_string()))?;
    if !meta.is_file() {
        return Err(AppError::msg_arg("fileMissing", vault.path.display().to_string()));
    }
    if meta.len() > MAX_FILE {
        return Err(AppError::msg("vaultTooBig"));
    }
    let data = std::fs::read(&vault.path)?;
    check_kdf(&data)?;

    let mut key = DatabaseKey::new();
    if let Some(pw) = vault.password.as_ref().filter(|p| !p.is_empty()) {
        key = key.with_password(pw.as_str());
    }
    if let Some(kf) = &vault.keyfile {
        let mut f = File::open(kf).map_err(|_| AppError::msg("vaultKeyfile"))?;
        key = key.with_keyfile(&mut f).map_err(|_| AppError::msg("vaultKeyfile"))?;
    }
    Database::parse(&data, key).map_err(map_open_error)
}

// ───────────────────────── Sesión ─────────────────────────

struct Open {
    vault_id: String,
    db: Database,
    touched: Instant,
}

/// El vault descifrado que se está navegando. Solo hay uno a la vez y vive solo en memoria de Rust.
#[derive(Default)]
pub struct Session(Mutex<Option<Open>>);

impl Session {
    pub fn set(&self, vault_id: String, db: Database) {
        *self.0.lock().unwrap() = Some(Open { vault_id, db, touched: Instant::now() });
    }

    /// Cierra el vault (los campos protegidos se borran al soltarse). Devuelve si había uno abierto.
    pub fn close(&self) -> bool {
        self.0.lock().unwrap().take().is_some()
    }

    #[cfg(test)]
    pub fn is_open(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    /// Ejecuta `f` con el vault abierto y cuenta la operación como actividad.
    pub fn with<T>(&self, vault_id: &str, f: impl FnOnce(&Database) -> Result<T>) -> Result<T> {
        let mut guard = self.0.lock().unwrap();
        let open = guard.as_mut().filter(|o| o.vault_id == vault_id).ok_or(AppError::msg("vaultClosed"))?;
        open.touched = Instant::now();
        f(&open.db)
    }

    /// Cierra el vault si lleva `idle` sin actividad. Devuelve si lo cerró.
    pub fn close_if_idle(&self, idle: Duration) -> bool {
        let mut guard = self.0.lock().unwrap();
        if guard.as_ref().is_some_and(|o| o.touched.elapsed() >= idle) {
            *guard = None;
            return true;
        }
        false
    }
}

// ───────────────────────── Vistas hacia la interfaz ─────────────────────────

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IconView {
    /// Icono estándar de KeePass (índice 0–68).
    Std { id: u32 },
    /// Icono incrustado en el fichero: clave de `TreeView::icons`.
    Custom { id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    id: String,
    parent: Option<String>,
    name: String,
    icon: Option<IconView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    id: String,
    group: String,
    title: String,
    username: String,
    url: String,
    icon: Option<IconView>,
    tags: Vec<String>,
    has_totp: bool,
    has_attachments: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeView {
    root: String,
    groups: Vec<GroupView>,
    entries: Vec<EntryRow>,
    /// Iconos personalizados ya validados, como `data:image/png;base64,…`.
    icons: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldView {
    name: String,
    protected: bool,
    /// Solo en los campos no protegidos; los protegidos se piden con `reveal_secret`.
    value: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentView {
    name: String,
    size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    id: String,
    title: String,
    username: String,
    url: String,
    /// Las notas pueden contener claves: solo viajan al abrir la entrada.
    notes: String,
    tags: Vec<String>,
    has_password: bool,
    has_totp: bool,
    fields: Vec<FieldView>,
    attachments: Vec<AttachmentView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpView {
    code: String,
    /// Segundos que le quedan al código.
    valid_for: u64,
    period: u64,
}

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_owned(),
        None => s.to_owned(),
    }
}

fn gid(id: GroupId) -> String {
    id.uuid().simple().to_string()
}

fn eid(id: EntryId) -> String {
    id.uuid().simple().to_string()
}

fn parse_entry_id(s: &str) -> Result<EntryId> {
    Uuid::parse_str(s).map(EntryId::from_uuid).map_err(|_| AppError::NotFound)
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// PNG con firma correcta, tamaño de fichero y dimensiones acotados (una bomba de descompresión de 64 KB
/// podría declarar decenas de miles de píxeles de lado). Cualquier otra cosa se descarta.
fn valid_png(d: &[u8]) -> bool {
    if d.len() > MAX_ICON_BYTES || d.len() < 33 || &d[..8] != PNG_MAGIC || &d[12..16] != b"IHDR" {
        return false;
    }
    let w = u32::from_be_bytes(d[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(d[20..24].try_into().unwrap());
    (1..=MAX_ICON_SIDE).contains(&w) && (1..=MAX_ICON_SIDE).contains(&h)
}

struct IconCollector<'a> {
    db: &'a Database,
    out: HashMap<String, String>,
}

impl IconCollector<'_> {
    fn view(&mut self, icon: Option<&Icon>) -> Option<IconView> {
        match icon? {
            Icon::BuiltIn(n) => Some(IconView::Std { id: (*n).min(1000) as u32 }),
            Icon::Custom(id) => {
                let key = id.uuid().simple().to_string();
                if self.out.contains_key(&key) {
                    return Some(IconView::Custom { id: key });
                }
                let ci = self.db.custom_icon(*id)?;
                if self.out.len() >= MAX_ICONS || !valid_png(&ci.data) {
                    return None;
                }
                self.out.insert(key.clone(), format!("data:image/png;base64,{}", base64(&ci.data)));
                Some(IconView::Custom { id: key })
            }
        }
    }
}

fn has_totp(e: &EntryRef) -> bool {
    e.get_raw_otp_value().is_some_and(|v| !v.is_empty())
}

fn entry_row(e: &EntryRef, group: GroupId, icons: &mut IconCollector) -> EntryRow {
    EntryRow {
        id: eid(e.id()),
        group: gid(group),
        title: clip(e.get_title().unwrap_or(""), MAX_ROW_TEXT),
        username: clip(e.get_username().unwrap_or(""), MAX_ROW_TEXT),
        url: clip(e.get_url().unwrap_or(""), MAX_ROW_TEXT),
        icon: icons.view(e.icon()),
        tags: e.tags.iter().take(16).map(|t| clip(t, 64)).collect(),
        has_totp: has_totp(e),
        has_attachments: e.attachments().next().is_some(),
    }
}

/// Árbol completo de grupos y entradas, **sin secretos**. La papelera de reciclaje se omite.
pub fn tree(db: &Database, show_icons: bool) -> TreeView {
    let recycle = db.recycle_bin().map(|g| g.id());
    let mut icons = IconCollector { db, out: HashMap::new() };
    let mut groups = Vec::new();
    let mut entries = Vec::new();

    let root_id = db.root().id();
    let mut stack: Vec<(GroupId, Option<GroupId>)> = vec![(root_id, None)];
    while let Some((id, parent)) = stack.pop() {
        if Some(id) == recycle {
            continue;
        }
        let Some(g) = db.group(id) else { continue };
        let icon = if show_icons { icons.view(g.icon()) } else { None };
        groups.push(GroupView {
            id: gid(g.id()),
            parent: parent.map(gid),
            name: clip(&g.name, MAX_ROW_TEXT),
            icon,
        });
        for e in g.entries() {
            let mut row = entry_row(&e, g.id(), &mut icons);
            if !show_icons {
                row.icon = None;
            }
            entries.push(row);
        }
        stack.extend(g.group_ids().map(|c| (c, Some(id))));
    }
    if !show_icons {
        icons.out.clear();
    }
    TreeView { root: gid(root_id), groups, entries, icons: icons.out }
}

/// Campos de la entrada que no son los estándar ni la semilla OTP (ni sus variantes antiguas).
fn is_custom_field(name: &str) -> bool {
    !fields::KNOWN_FIELDS.contains(&name)
        && !name.eq_ignore_ascii_case(fields::OTP)
        && !name.starts_with("TimeOtp-")
        && !name.starts_with("TOTP ")
}

pub fn detail(db: &Database, entry_id: &str) -> Result<EntryDetail> {
    let id = parse_entry_id(entry_id)?;
    let e = db.entry(id).ok_or(AppError::NotFound)?;
    let mut custom: Vec<FieldView> = e
        .fields
        .iter()
        .filter(|(k, _)| is_custom_field(k))
        .map(|(k, v)| FieldView {
            name: clip(k, MAX_ROW_TEXT),
            protected: v.is_protected(),
            value: (!v.is_protected()).then(|| clip(v.get(), MAX_FIELD_TEXT)),
        })
        .collect();
    custom.sort_by(|a, b| a.name.cmp(&b.name));
    let mut attachments: Vec<AttachmentView> = e
        .attachments_named()
        .map(|(n, a)| AttachmentView { name: clip(n, MAX_ROW_TEXT), size: a.data.get().len() })
        .collect();
    attachments.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(EntryDetail {
        id: eid(id),
        title: clip(e.get_title().unwrap_or(""), MAX_ROW_TEXT),
        username: clip(e.get_username().unwrap_or(""), MAX_FIELD_TEXT),
        url: clip(e.get_url().unwrap_or(""), MAX_FIELD_TEXT),
        notes: clip(e.get(fields::NOTES).unwrap_or(""), MAX_NOTES),
        tags: e.tags.iter().take(16).map(|t| clip(t, 64)).collect(),
        has_password: e.get_password().is_some_and(|p| !p.is_empty()),
        has_totp: has_totp(&e),
        fields: custom,
        attachments,
    })
}

// ───────────────────────── Secretos bajo demanda ─────────────────────────

/// Valor de un campo para copiar o revelar. `field`: `username`, `password`, `url`, `notes`, `totp`
/// o `custom:<nombre>`.
pub fn secret(db: &Database, entry_id: &str, field: &str) -> Result<Zeroizing<String>> {
    let e = db.entry(parse_entry_id(entry_id)?).ok_or(AppError::NotFound)?;
    let text = match field {
        "username" => e.get(fields::USERNAME),
        "password" => e.get(fields::PASSWORD),
        "url" => e.get(fields::URL),
        "notes" => e.get(fields::NOTES),
        "totp" => return totp_code(&e).map(|t| Zeroizing::new(t.code)),
        other => {
            let name = other.strip_prefix("custom:").ok_or(AppError::NotFound)?;
            if !is_custom_field(name) {
                return Err(AppError::NotFound);
            }
            e.get(name)
        }
    };
    Ok(Zeroizing::new(text.ok_or(AppError::NotFound)?.to_owned()))
}

fn totp_code(e: &EntryRef) -> Result<TotpView> {
    let otp = e.get_otp().map_err(|_| AppError::msg("vaultNoTotp"))?;
    let c = otp.value_now().map_err(|_| AppError::msg("vaultNoTotp"))?;
    Ok(TotpView { code: c.code.clone(), valid_for: c.valid_for.as_secs(), period: c.period.as_secs() })
}

pub fn totp(db: &Database, entry_id: &str) -> Result<TotpView> {
    let e = db.entry(parse_entry_id(entry_id)?).ok_or(AppError::NotFound)?;
    totp_code(&e)
}

/// Bytes de un adjunto, para guardarlos. No viajan a la interfaz.
pub fn attachment(db: &Database, entry_id: &str, name: &str) -> Result<Zeroizing<Vec<u8>>> {
    let e = db.entry(parse_entry_id(entry_id)?).ok_or(AppError::NotFound)?;
    let a = e.attachment_by_name(name).ok_or(AppError::NotFound)?;
    Ok(Zeroizing::new(a.data.get().clone()))
}

// ───────────────────────── Informe para compartir ─────────────────────────

/// Tope de entradas por informe: es para enviar unas pocas credenciales, no para volcar un vault.
pub const MAX_REPORT_ENTRIES: usize = 100;

/// Qué incluir además de título, usuario, contraseña y dirección.
#[derive(Clone, Copy)]
pub struct ReportOptions {
    pub include_custom: bool,
    pub include_notes: bool,
}

/// Etiquetas del informe en el idioma de la interfaz (cualquier otro idioma usa inglés).
fn labels(lang: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match lang {
        "es" => ("Usuario", "Contraseña", "Dirección", "Notas"),
        _ => ("Username", "Password", "Address", "Notes"),
    }
}

/// Texto plano listo para pegar en una herramienta de compartir secretos. Se construye aquí, en Rust:
/// las contraseñas no pasan por la interfaz. Nunca incluye el código TOTP (caduca en segundos) ni su semilla,
/// ni adjuntos. Los campos vacíos se omiten.
pub fn report(db: &Database, entry_ids: &[String], opts: ReportOptions, lang: &str) -> Result<Zeroizing<String>> {
    if entry_ids.is_empty() || entry_ids.len() > MAX_REPORT_ENTRIES {
        return Err(AppError::msg("reportCount"));
    }
    let (l_user, l_pass, l_url, l_notes) = labels(lang);
    let mut out = Zeroizing::new(String::with_capacity(512 * entry_ids.len()));
    for (i, raw) in entry_ids.iter().enumerate() {
        let e = db.entry(parse_entry_id(raw)?).ok_or(AppError::NotFound)?;
        if i > 0 {
            out.push('\n');
        }
        let title = e.get_title().filter(|t| !t.trim().is_empty()).unwrap_or("-");
        out.push_str(&format!("== {} ==\n", one_line(title)));
        let mut line = |label: &str, value: Option<&str>| {
            if let Some(v) = value.filter(|v| !v.is_empty()) {
                out.push_str(&format!("{label}: {}\n", one_line(v)));
            }
        };
        line(l_user, e.get(fields::USERNAME));
        line(l_pass, e.get(fields::PASSWORD));
        line(l_url, e.get(fields::URL));
        if opts.include_custom {
            let mut names: Vec<&String> = e.fields.keys().filter(|k| is_custom_field(k)).collect();
            names.sort();
            for name in names {
                line(&one_line(name), e.get(name));
            }
        }
        if opts.include_notes {
            if let Some(n) = e.get(fields::NOTES).filter(|n| !n.trim().is_empty()) {
                out.push_str(&format!("{l_notes}:\n"));
                for l in n.lines() {
                    out.push_str(&format!("  {l}\n"));
                }
            }
        }
    }
    Ok(out)
}

/// Un valor de una sola línea: los saltos dentro de un campo no deben partir el informe.
fn one_line(s: &str) -> String {
    s.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepass::db::Value;

    const PW: &str = "pw-de-prueba";

    /// Crea un `.kdbx` KDBX4 con un grupo, una entrada con secretos, adjunto, icono y TOTP.
    fn sample(dir: &std::path::Path, png: Vec<u8>) -> Vault {
        let mut db = Database::new();
        {
            let mut root = db.root_mut();
            let mut g = root.add_group();
            g.name = "Hosting".into();
            let mut e = g.add_entry();
            e.set_unprotected(fields::TITLE, "Panel");
            e.set_unprotected(fields::USERNAME, "admin");
            e.set_protected(fields::PASSWORD, "SECRETO-123");
            e.set_unprotected(fields::URL, "https://example.com");
            e.set_unprotected(fields::NOTES, "nota con CLAVE-EN-NOTA");
            e.set_protected("API key", "TOKEN-XYZ");
            e.set_unprotected("Cuenta", "A-1");
            e.set_unprotected(
                fields::OTP,
                "otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=x",
            );
            e.tags = vec!["web".into()];
            e.add_attachment("../../mal:nombre.txt", Value::protected(b"contenido".to_vec()));
            e.set_icon_custom_new(png);
        }
        let path = dir.join("v.kdbx");
        let key = DatabaseKey::new().with_password(PW);
        let mut f = File::create(&path).unwrap();
        db.save(&mut f, key).unwrap();
        Vault {
            id: "1".into(),
            client: "c".into(),
            path,
            password: Some(Zeroizing::new(PW.into())),
            ..Default::default()
        }
    }

    /// PNG mínimo válido de 1×1 (la firma y la cabecera IHDR bastan para nuestra validación).
    fn tiny_png() -> Vec<u8> {
        let mut v = PNG_MAGIC.to_vec();
        v.extend_from_slice(&[0, 0, 0, 13]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0; 20]);
        v
    }

    #[test]
    fn tree_has_no_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let vault = sample(dir.path(), tiny_png());
        let db = open(&vault).unwrap();
        let json = serde_json::to_string(&tree(&db, true)).unwrap();
        for secret in ["SECRETO-123", "CLAVE-EN-NOTA", "TOKEN-XYZ", "JBSWY3DPEHPK3PXP", "otpauth"] {
            assert!(!json.contains(secret), "el árbol filtra {secret}");
        }
        assert!(json.contains("Panel") && json.contains("Hosting") && json.contains("admin"));
        assert!(json.contains("\"hasTotp\":true"));
    }

    #[test]
    fn detail_hides_protected_values_but_shows_notes() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&sample(dir.path(), tiny_png())).unwrap();
        let id = tree(&db, true).entries[0].id.clone();
        let d = detail(&db, &id).unwrap();
        let json = serde_json::to_string(&d).unwrap();
        assert!(!json.contains("SECRETO-123") && !json.contains("TOKEN-XYZ") && !json.contains("JBSWY3DPEHPK3PXP"));
        assert!(d.notes.contains("CLAVE-EN-NOTA"));
        assert!(d.has_password && d.has_totp);
        let api = d.fields.iter().find(|f| f.name == "API key").unwrap();
        assert!(api.protected && api.value.is_none());
        let cuenta = d.fields.iter().find(|f| f.name == "Cuenta").unwrap();
        assert_eq!(cuenta.value.as_deref(), Some("A-1"));
        assert!(!d.fields.iter().any(|f| f.name.eq_ignore_ascii_case("otp")), "la semilla no es un campo visible");
        assert_eq!(d.attachments[0].size, 9);
    }

    #[test]
    fn secrets_are_available_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&sample(dir.path(), tiny_png())).unwrap();
        let id = tree(&db, true).entries[0].id.clone();
        assert_eq!(secret(&db, &id, "password").unwrap().as_str(), "SECRETO-123");
        assert_eq!(secret(&db, &id, "custom:API key").unwrap().as_str(), "TOKEN-XYZ");
        assert_eq!(secret(&db, &id, "totp").unwrap().len(), 6);
        assert!(secret(&db, &id, "custom:otp").is_err(), "la semilla no se pide como campo");
        assert!(secret(&db, &id, "custom:Title").is_err());
        assert!(secret(&db, &id, "nada").is_err());
        assert_eq!(attachment(&db, &id, "../../mal:nombre.txt").unwrap().as_slice(), b"contenido");
        assert!(secret(&db, "no-es-un-uuid", "password").is_err());
    }

    #[test]
    fn valid_icons_pass_and_bad_ones_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&sample(dir.path(), tiny_png())).unwrap();
        let t = tree(&db, true);
        assert_eq!(t.icons.len(), 1);
        assert!(t.icons.values().all(|v| v.starts_with("data:image/png;base64,")));

        let dir2 = tempfile::tempdir().unwrap();
        let db2 = open(&sample(dir2.path(), b"<svg onload=alert(1)></svg>".to_vec())).unwrap();
        let t2 = tree(&db2, true);
        assert!(t2.icons.is_empty());
        assert!(t2.entries[0].icon.is_none());

        assert!(tree(&db, false).icons.is_empty(), "sin iconos no se envía ninguno");
    }

    #[test]
    fn png_validation_limits() {
        assert!(valid_png(&tiny_png()));
        let mut huge = tiny_png();
        huge[16..20].copy_from_slice(&40_000u32.to_be_bytes());
        assert!(!valid_png(&huge), "dimensiones absurdas");
        let mut big = tiny_png();
        big.resize(MAX_ICON_BYTES + 1, 0);
        assert!(!valid_png(&big), "demasiado grande");
        assert!(!valid_png(b"GIF89a"));
    }

    #[test]
    fn wrong_password_and_missing_credentials_are_clean_errors() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = sample(dir.path(), tiny_png());
        vault.password = Some(Zeroizing::new("otra".into()));
        assert!(matches!(open(&vault), Err(AppError::Msg { code: "vaultWrongKey", .. })));
        vault.password = None;
        assert!(matches!(open(&vault), Err(AppError::Msg { code: "vaultNoCredentials", .. })));
    }

    #[test]
    fn truncated_or_garbage_files_fail_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = sample(dir.path(), tiny_png());
        let bytes = std::fs::read(&vault.path).unwrap();
        for cut in [0usize, 5, 11, 40, bytes.len() / 2] {
            std::fs::write(&vault.path, &bytes[..cut]).unwrap();
            assert!(open(&vault).is_err(), "cut {cut}");
        }
        std::fs::write(&vault.path, vec![0xAB; 4096]).unwrap();
        vault.password = Some(Zeroizing::new(PW.into()));
        assert!(open(&vault).is_err());
    }

    #[test]
    fn absurd_kdf_parameters_are_rejected_before_deriving() {
        let dir = tempfile::tempdir().unwrap();
        let vault = sample(dir.path(), tiny_png());
        let mut bytes = std::fs::read(&vault.path).unwrap();
        // Localiza la clave "M" del diccionario de la KDF y le pone 64 GiB.
        let pos = bytes
            .windows(10)
            .position(|w| w[0] == 0x05 && w[1..5] == 1u32.to_le_bytes() && w[5] == b'M' && w[6..10] == 8u32.to_le_bytes())
            .expect("parámetro M de Argon2");
        bytes[pos + 10..pos + 18].copy_from_slice(&(64u64 << 30).to_le_bytes());
        std::fs::write(&vault.path, &bytes).unwrap();
        assert!(matches!(open(&vault), Err(AppError::Msg { code: "vaultTooHeavy", .. })));
    }

    #[test]
    fn session_closes_when_idle_and_checks_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&sample(dir.path(), tiny_png())).unwrap();
        let s = Session::default();
        s.set("1".into(), db);
        assert!(s.with("1", |_| Ok(())).is_ok());
        assert!(s.with("2", |_| Ok(())).is_err(), "otro vault no se sirve");
        assert!(!s.close_if_idle(Duration::from_secs(60)));
        assert!(s.close_if_idle(Duration::ZERO));
        assert!(!s.is_open());
        assert!(s.with("1", |_| Ok(())).is_err());
    }

    #[test]
    fn report_contains_only_the_selected_entries_and_no_totp() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = sample(dir.path(), tiny_png());
        // Segunda entrada, que no se selecciona.
        let mut db = open(&vault).unwrap();
        let gid = db.root().group_ids().next().unwrap();
        {
            let mut g = db.group_mut(gid).unwrap();
            let mut e = g.add_entry();
            e.set_unprotected(fields::TITLE, "Otra");
            e.set_protected(fields::PASSWORD, "NO-INCLUIR");
        }
        let mut f = File::create(&vault.path).unwrap();
        db.save(&mut f, DatabaseKey::new().with_password(PW)).unwrap();
        vault.password = Some(Zeroizing::new(PW.into()));
        let db = open(&vault).unwrap();
        let t = tree(&db, true);
        let panel = t.entries.iter().find(|e| e.title == "Panel").unwrap().id.clone();

        let opts = ReportOptions { include_custom: false, include_notes: false };
        let r = report(&db, &[panel.clone()], opts, "es").unwrap();
        assert!(r.contains("== Panel ==") && r.contains("Usuario: admin") && r.contains("Contraseña: SECRETO-123"));
        assert!(r.contains("Dirección: https://example.com"));
        for no in ["NO-INCLUIR", "Otra", "CLAVE-EN-NOTA", "TOKEN-XYZ", "A-1", "JBSWY3DPEHPK3PXP", "otpauth", "contenido"] {
            assert!(!r.contains(no), "no debería incluir {no}");
        }

        let full = report(&db, &[panel], ReportOptions { include_custom: true, include_notes: true }, "en").unwrap();
        assert!(full.contains("Password: SECRETO-123") && full.contains("API key: TOKEN-XYZ") && full.contains("Cuenta: A-1"));
        assert!(full.contains("Notes:\n  nota con CLAVE-EN-NOTA"));
        assert!(!full.contains("JBSWY3DPEHPK3PXP") && !full.contains("otpauth"), "ni la semilla TOTP ni el campo otp");
    }

    #[test]
    fn report_rejects_bad_selections_and_flattens_values() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(&sample(dir.path(), tiny_png())).unwrap();
        let id = tree(&db, true).entries[0].id.clone();
        let opts = ReportOptions { include_custom: true, include_notes: true };
        assert!(report(&db, &[], opts, "es").is_err());
        assert!(report(&db, &vec![id.clone(); MAX_REPORT_ENTRIES + 1], opts, "es").is_err());
        assert!(report(&db, &["no-es-un-uuid".into()], opts, "es").is_err());
        assert!(report(&db, &[Uuid::new_v4().simple().to_string()], opts, "es").is_err());
        assert_eq!(one_line("a\r\nb\nc\rd"), "a b c d");
    }
}
