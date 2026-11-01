use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::backup;
use crate::crypto::Keys;
use crate::error::{AppError, Result};
use crate::hello::{self, Hello};
use crate::keepass;
use crate::prefs::{LANGUAGES, Prefs, PrefsState, THEMES};
use crate::shell;
use crate::model::{Executable, Vault};
use crate::scan::{self, Candidate, is_under, path_key};
use crate::store::Store;
use crate::vaultdb::{self, EntryDetail, Session, TotpView, TreeView};
use crate::{attach, clipboard::Clipboard};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    id: String,
    client: String,
    path: String,
    keyfile: Option<String>,
    has_password: bool,
    favorite: bool,
    last_opened: Option<u64>,
    tags: Vec<String>,
    open_external: bool,
}

impl From<&Vault> for VaultView {
    fn from(v: &Vault) -> Self {
        Self {
            id: v.id.clone(),
            client: v.client.clone(),
            path: v.path.to_string_lossy().into_owned(),
            keyfile: v.keyfile.as_ref().map(|k| k.to_string_lossy().into_owned()),
            has_password: v.password.as_ref().is_some_and(|p| !p.is_empty()),
            favorite: v.favorite,
            last_opened: v.last_opened,
            tags: v.tags.clone(),
            open_external: v.open_external,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInput {
    client: String,
    path: String,
    keyfile: Option<String>,
    /// `None` o vacío = no cambiar la contraseña guardada.
    password: Option<String>,
    #[serde(default)]
    clear_password: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    open_external: bool,
}

impl VaultInput {
    fn validate(&self) -> Result<()> {
        if self.client.trim().is_empty() || self.path.trim().is_empty() {
            return Err(AppError::msg("clientPathRequired"));
        }
        Ok(())
    }

    fn apply(self, v: &mut Vault) {
        v.client = self.client.trim().to_owned();
        v.path = PathBuf::from(self.path.trim());
        v.keyfile = self.keyfile.filter(|k| !k.trim().is_empty()).map(PathBuf::from);
        v.tags = crate::model::normalize_tags(self.tags);
        v.open_external = self.open_external;
        if self.clear_password {
            v.password = None;
        } else if let Some(p) = self.password.filter(|p| !p.is_empty()) {
            v.password = Some(Zeroizing::new(p));
        }
    }
}

#[derive(Deserialize)]
pub struct ImportItem {
    client: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    exists: bool,
    unlocked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    keepassxc_path: Option<String>,
    default_keyfile: Option<String>,
}

#[tauri::command]
pub fn status(store: State<Store>) -> Status {
    Status { exists: store.exists(), unlocked: store.is_unlocked() }
}

#[tauri::command]
pub fn unlock(store: State<Store>, password: String) -> Result<()> {
    let password = Zeroizing::new(password);
    store.unlock(&password)
}

#[tauri::command]
pub fn lock(app: tauri::AppHandle) {
    shell::lock_state(&app);
}

#[tauri::command]
pub fn change_master_password(store: State<Store>, hello: State<Hello>, password: String) -> Result<()> {
    let password = Zeroizing::new(password);
    store.change_password(&password)?;
    // La contraseña guardada para Hello ya no sirve; hay que volver a activarlo.
    hello.disable();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloStatus {
    supported: bool,
    enabled: bool,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

#[tauri::command]
pub async fn hello_status(hello: State<'_, Hello>) -> Result<HelloStatus> {
    let enabled = hello.enabled();
    let supported = blocking(|| Ok(hello::supported())).await?;
    Ok(HelloStatus { supported, enabled })
}

/// Pide la contraseña maestra (se verifica) y la protege con Windows Hello.
#[tauri::command]
pub async fn hello_enable(store: State<'_, Store>, hello: State<'_, Hello>, password: String) -> Result<()> {
    let password = Zeroizing::new(password);
    store.verify(&password)?;
    let hello = hello.inner().clone();
    blocking(move || hello.enable(&password)).await
}

#[tauri::command]
pub fn hello_disable(hello: State<Hello>) {
    hello.disable();
}

/// Borra todos los datos cifrados (clientes, credenciales, carpetas, contraseña maestra y Windows Hello).
/// Conserva las preferencias de aspecto y no toca ningún `.kdbx`.
#[tauri::command]
pub fn reset_data(store: State<Store>, hello: State<Hello>) -> Result<()> {
    store.erase()?;
    hello.disable();
    Ok(())
}

// ───────────────────────── Ubicación del fichero de datos ─────────────────────────

const DATA_FILE_NAME: &str = "vaults.enc";

/// Dónde guarda el fichero de datos si el usuario no elige otro sitio.
pub struct DefaultDataFile(pub PathBuf);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocation {
    path: String,
    is_default: bool,
    exists: bool,
}

fn data_location_view(store: &Store, default: &DefaultDataFile) -> DataLocation {
    let path = store.path();
    DataLocation { path: path.to_string_lossy().into_owned(), is_default: path == default.0, exists: path.is_file() }
}

#[tauri::command]
pub fn data_location(store: State<Store>, default: State<DefaultDataFile>) -> DataLocation {
    data_location_view(&store, &default)
}

/// Cambia dónde se guarda el fichero de datos. Los cuadros de selección los abre Rust: la interfaz nunca decide
/// una ruta. `action`:
/// - `folder`: elegir una carpeta (el fichero será `vaults.enc` dentro de ella);
/// - `existing`: usar un fichero de datos que ya existe (de otro equipo, de una copia…);
/// - `default`: volver a la carpeta de configuración de la app.
///
/// Con `move_data` y la app desbloqueada, el fichero actual se copia al destino (sin pisar nada), se comprueba
/// y se borra el antiguo. Sin ello se pasa a usar el fichero del destino, que se desbloqueará con su propia
/// contraseña maestra, y la app se bloquea. Devuelve `None` si el usuario cancela el cuadro.
#[tauri::command]
pub async fn change_data_location(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    prefs: State<'_, PrefsState>,
    hello: State<'_, Hello>,
    default: State<'_, DefaultDataFile>,
    action: String,
    move_data: bool,
) -> Result<Option<DataLocation>> {
    use tauri_plugin_dialog::DialogExt;

    let default_path = default.0.clone();
    let picker = app.clone();
    let target: PathBuf = match action.as_str() {
        "default" => default_path.clone(),
        "folder" => {
            let dir = blocking(move || Ok(picker.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()))).await?;
            match dir {
                Some(dir) => dir.join(DATA_FILE_NAME),
                None => return Ok(None),
            }
        }
        "existing" => {
            let file = blocking(move || {
                Ok(picker.dialog().file().add_filter("KP Manager", &["enc"]).blocking_pick_file().and_then(|p| p.into_path().ok()))
            })
            .await?;
            match file {
                Some(file) => file,
                None => return Ok(None),
            }
        }
        _ => return Err(AppError::NotFound),
    };

    // Un fichero que ya está en el destino debe ser de KP Manager; si lo elegido es «uno existente», debe estar.
    let present = target.is_file();
    if present && !Keys::looks_valid(&std::fs::read(&target)?) {
        return Err(AppError::msg("dataNotKpm"));
    }
    if action == "existing" && !present {
        return Err(AppError::msg("dataNotKpm"));
    }
    if target == store.path() {
        return Ok(Some(data_location_view(&store, &default)));
    }
    let stored = (target != default_path).then(|| target.to_string_lossy().into_owned());

    if move_data && action != "existing" && store.is_unlocked() {
        let old = store.relocate(target.clone())?;
        if let Err(e) = prefs.update(|p| p.data_file = stored) {
            // No se pudo recordar el cambio: se vuelve al fichero de antes y se retira la copia.
            store.force_path(old);
            let _ = std::fs::remove_file(&target);
            return Err(e);
        }
        // Todo está en su sitio: el fichero antiguo ya no hace falta.
        let _ = std::fs::remove_file(&old);
    } else {
        let before = store.path();
        if store.is_unlocked() {
            shell::lock_all(&app);
        }
        store.set_path(target)?;
        if let Err(e) = prefs.update(|p| p.data_file = stored) {
            store.force_path(before);
            return Err(e);
        }
        // La contraseña maestra que guarda Windows Hello era la del fichero anterior.
        hello.disable();
    }
    Ok(Some(data_location_view(&store, &default)))
}

/// Recoge los cambios que otro equipo haya sincronizado en el fichero de datos (OneDrive, Drive…). Devuelve si
/// hubo alguno. Si el fichero ya no se puede leer con lo que tenemos (otra contraseña maestra, o una versión más
/// nueva de la app), se bloquea y el error llega a la interfaz.
#[tauri::command]
pub fn sync_data(app: tauri::AppHandle, store: State<Store>) -> Result<bool> {
    match store.sync() {
        Err(e @ AppError::Msg { code: "dataKeyChanged" | "dataNewer", .. }) => {
            shell::lock_all(&app);
            Err(e)
        }
        other => other,
    }
}

/// Autentica con Windows Hello y desbloquea. Si falla, la UI cae a la contraseña maestra.
#[tauri::command]
pub async fn hello_unlock(store: State<'_, Store>, hello: State<'_, Hello>) -> Result<()> {
    let h = hello.inner().clone();
    let password = blocking(move || h.unlock()).await?;
    match store.unlock(&password) {
        Err(AppError::WrongPassword) => {
            hello.disable();
            Err(AppError::msg("helloStaleMaster"))
        }
        other => other,
    }
}

#[tauri::command]
pub fn list_vaults(store: State<Store>) -> Result<Vec<VaultView>> {
    store.read(|d| d.vaults.iter().map(VaultView::from).collect())
}

#[tauri::command]
pub fn add_vault(store: State<Store>, input: VaultInput) -> Result<VaultView> {
    input.validate()?;
    store.write(|d| {
        let mut v = Vault { id: uuid::Uuid::new_v4().to_string(), ..Default::default() };
        input.apply(&mut v);
        let view = VaultView::from(&v);
        d.vaults.push(v);
        Ok(view)
    })
}

#[tauri::command]
pub fn update_vault(store: State<Store>, id: String, input: VaultInput) -> Result<VaultView> {
    input.validate()?;
    store.write(|d| {
        let v = d.vaults.iter_mut().find(|v| v.id == id).ok_or(AppError::NotFound)?;
        input.apply(v);
        Ok(VaultView::from(&*v))
    })
}

#[tauri::command]
pub fn delete_vault(store: State<Store>, id: String) -> Result<()> {
    store.write(|d| {
        let before = d.vaults.len();
        d.vaults.retain(|v| v.id != id);
        if d.vaults.len() == before { Err(AppError::NotFound) } else { Ok(()) }
    })
}

#[tauri::command]
pub async fn scan_folder(store: State<'_, Store>, path: String) -> Result<Vec<Candidate>> {
    let (existing, ignored): (HashSet<String>, HashSet<String>) = store.read(|d| {
        (
            d.vaults.iter().map(|v| path_key(&v.path)).collect(),
            d.ignored.iter().map(|p| path_key(p)).collect(),
        )
    })?;
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(AppError::msg("folderMissing"));
    }
    // Escaneo completo: devuelve también los descartados, marcados para que la UI los distinga.
    let mut found = scan::scan_dir(&root, &existing);
    for c in &mut found {
        c.ignored = !c.already && ignored.contains(&path_key(&c.path));
    }
    Ok(found)
}

/// Da de alta los candidatos seleccionados (ignora los ya registrados). Devuelve cuántos se añadieron.
#[tauri::command]
pub fn import_candidates(store: State<Store>, items: Vec<ImportItem>) -> Result<usize> {
    store.write(|d| {
        let mut known: HashSet<String> = d.vaults.iter().map(|v| path_key(&v.path)).collect();
        let mut added = 0;
        for it in items {
            let path = PathBuf::from(&it.path);
            if it.client.trim().is_empty() || !known.insert(path_key(&path)) {
                continue;
            }
            d.vaults.push(Vault {
                id: uuid::Uuid::new_v4().to_string(),
                client: it.client.trim().to_owned(),
                path,
                ..Default::default()
            });
            added += 1;
        }
        Ok(added)
    })
}

#[tauri::command]
pub fn open_vault(store: State<Store>, id: String) -> Result<()> {
    let (vault, configured) = store.read(|d| {
        (d.vaults.iter().find(|v| v.id == id).cloned(), d.settings.keepassxc.clone())
    })?;
    let vault = vault.ok_or(AppError::NotFound)?;
    let exe = configured.or_else(keepass::detect).ok_or(AppError::KeePassNotFound)?;
    keepass::open(&exe, &vault)?;
    // Registrar el último uso no debe hacer fallar una apertura que ya ha tenido éxito.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = store.write(|d| {
        if let Some(v) = d.vaults.iter_mut().find(|v| v.id == id) {
            v.last_opened = Some(now);
        }
        Ok(())
    });
    Ok(())
}

#[tauri::command]
pub fn set_favorite(store: State<Store>, id: String, favorite: bool) -> Result<()> {
    store.write(|d| {
        d.vaults.iter_mut().find(|v| v.id == id).ok_or(AppError::NotFound)?.favorite = favorite;
        Ok(())
    })
}

#[tauri::command]
pub fn get_prefs(prefs: State<PrefsState>) -> Prefs {
    prefs.get()
}

/// Preferencias editables desde Ajustes (el atajo global tiene su propio comando).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsUpdate {
    minimize_to_tray: bool,
    close_to_tray: bool,
    lock_on_hide: bool,
    sort_by_name: bool,
    theme: String,
    language: String,
    check_updates: bool,
    clipboard_clear_secs: u32,
    vault_idle_minutes: u32,
    hide_from_capture: bool,
    show_vault_icons: bool,
}

#[tauri::command]
pub fn set_prefs(prefs: State<PrefsState>, update: PrefsUpdate) -> Result<Prefs> {
    // Un valor desconocido (fichero editado a mano, versión futura) vuelve al predeterminado.
    let theme = if THEMES.contains(&update.theme.as_str()) { update.theme } else { "system".into() };
    let language = if LANGUAGES.contains(&update.language.as_str()) { update.language } else { "auto".into() };
    prefs.update(|p| {
        p.minimize_to_tray = update.minimize_to_tray;
        p.close_to_tray = update.close_to_tray;
        p.lock_on_hide = update.lock_on_hide;
        p.sort_by_name = update.sort_by_name;
        p.theme = theme;
        p.language = language;
        p.check_updates = update.check_updates;
        p.clipboard_clear_secs = update.clipboard_clear_secs.min(600);
        p.vault_idle_minutes = update.vault_idle_minutes.min(240);
        p.hide_from_capture = update.hide_from_capture;
        p.show_vault_icons = update.show_vault_icons;
    })
}

/// Recuerda que el usuario ignora esta versión (`None` o vacío = volver a avisar).
#[tauri::command]
pub fn ignore_update(prefs: State<PrefsState>, version: Option<String>) -> Result<Prefs> {
    let version = version.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    prefs.update(|p| p.ignored_update = version)
}

/// Idioma ya resuelto por la interfaz (`es` | `en`) para los textos nativos: menú de la bandeja.
#[tauri::command]
pub fn set_tray_language(app: tauri::AppHandle, language: String) {
    shell::set_tray_language(&app, &language);
}

/// `None` o vacío quita el atajo global. Si no se puede registrar, el anterior se conserva.
#[tauri::command]
pub fn set_shortcut(
    app: tauri::AppHandle,
    prefs: State<PrefsState>,
    status: State<shell::ShortcutStatus>,
    shortcut: Option<String>,
) -> Result<Prefs> {
    let shortcut = shortcut.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let old = prefs.get().shortcut;
    shell::change_shortcut(&app, old.as_deref(), shortcut.as_deref())?;
    status.set(&Ok(())); // el nuevo atajo sí quedó registrado
    prefs.update(|p| p.shortcut = shortcut)
}

/// Motivo por el que el atajo global no está activo, si no lo está (`{code, arg, message}`).
#[tauri::command]
pub fn shortcut_status(status: State<shell::ShortcutStatus>) -> Option<serde_json::Value> {
    status.get()
}

#[tauri::command]
pub fn get_settings(store: State<Store>) -> Result<SettingsView> {
    store.read(|d| SettingsView {
        keepassxc_path: d.settings.keepassxc.as_ref().map(Executable::display),
        default_keyfile: d.settings.default_keyfile.as_ref().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// `None` o vacío quita la keyfile predeterminada.
#[tauri::command]
pub fn set_default_keyfile(store: State<Store>, path: Option<String>) -> Result<SettingsView> {
    let kf = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p.trim());
            if !p.is_file() {
                return Err(AppError::msg("keyfileMissing"));
            }
            Some(p)
        }
        None => None,
    };
    store.write(|d| {
        d.settings.default_keyfile = kf;
        Ok(())
    })?;
    get_settings(store)
}

/// `None` o vacío borra la ruta manual (vuelve a la autodetección).
#[tauri::command]
pub fn set_keepassxc_path(store: State<Store>, path: Option<String>) -> Result<SettingsView> {
    let exe = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p.trim());
            if !p.is_file() {
                return Err(AppError::msg("exeMissing"));
            }
            Some(Executable::from_program(p))
        }
        None => None,
    };
    store.write(|d| {
        d.settings.keepassxc = exe;
        Ok(())
    })?;
    get_settings(store)
}

#[tauri::command]
pub fn detect_keepassxc(store: State<Store>) -> Result<SettingsView> {
    let exe = keepass::detect().ok_or(AppError::KeePassNotFound)?;
    store.write(|d| {
        d.settings.keepassxc = Some(exe);
        Ok(())
    })?;
    get_settings(store)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// .kdbx en carpetas vigiladas que no están registrados ni ignorados.
    new: Vec<Candidate>,
    /// Vaults registrados dentro de una carpeta vigilada cuyo fichero ya no existe.
    missing: Vec<VaultView>,
    /// Carpetas vigiladas que no se pueden leer (unidad desconectada, red caída…).
    unreachable: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    path: String,
    /// La carpeta se puede leer ahora mismo.
    reachable: bool,
    /// Vaults registrados que están dentro de ella.
    vaults: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedView {
    folders: Vec<WatchedFolder>,
    /// Vaults que el usuario descartó en una revisión y no se vuelven a proponer.
    ignored_count: usize,
}

#[tauri::command]
pub async fn list_watched(store: State<'_, Store>) -> Result<WatchedView> {
    let (watched, vaults, ignored) =
        store.read(|d| (d.watched.clone(), d.vaults.clone(), d.ignored.len()))?;
    let folders = watched
        .iter()
        .map(|w| WatchedFolder {
            path: w.to_string_lossy().into_owned(),
            reachable: w.is_dir(),
            vaults: vaults.iter().filter(|v| is_under(&v.path, w)).count(),
        })
        .collect();
    Ok(WatchedView { folders, ignored_count: ignored })
}

/// Vuelve a proponer los vaults que se habían descartado.
#[tauri::command]
pub fn clear_ignored(store: State<Store>) -> Result<()> {
    store.write(|d| {
        d.ignored.clear();
        Ok(())
    })
}

#[tauri::command]
pub fn add_watched(store: State<Store>, path: String) -> Result<()> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err(AppError::msg("folderMissing"));
    }
    store.write(|d| {
        if !d.watched.iter().any(|w| path_key(w) == path_key(&p)) {
            d.watched.push(p);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn remove_watched(store: State<Store>, path: String) -> Result<()> {
    let key = path_key(&PathBuf::from(path));
    store.write(|d| {
        d.watched.retain(|w| path_key(w) != key);
        Ok(())
    })
}

/// Revisa las carpetas en seguimiento y devuelve lo nuevo y lo desaparecido.
#[tauri::command]
pub async fn check_watched(store: State<'_, Store>) -> Result<SyncReport> {
    let (vaults, watched, ignored) =
        store.read(|d| (d.vaults.clone(), d.watched.clone(), d.ignored.clone()))?;
    Ok(sync_report(&vaults, &watched, &ignored))
}

fn sync_report(vaults: &[Vault], watched: &[PathBuf], ignored: &[PathBuf]) -> SyncReport {
    let known: HashSet<String> = vaults.iter().map(|v| path_key(&v.path)).collect();
    let ignored: HashSet<String> = ignored.iter().map(|p| path_key(p)).collect();

    let (mut new, mut unreachable, mut reachable) = (Vec::new(), Vec::new(), Vec::new());
    for root in watched {
        if !root.is_dir() {
            unreachable.push(root.to_string_lossy().into_owned());
            continue;
        }
        reachable.push(root.clone());
        new.extend(
            scan::scan_dir(root, &known)
                .into_iter()
                .filter(|c| !c.already && !ignored.contains(&path_key(&c.path))),
        );
    }
    // Carpetas vigiladas anidadas pueden devolver el mismo fichero dos veces.
    let mut seen = HashSet::new();
    new.retain(|c| seen.insert(path_key(&c.path)));

    let missing = vaults
        .iter()
        .filter(|v| reachable.iter().any(|r| is_under(&v.path, r)) && !v.path.is_file())
        .map(VaultView::from)
        .collect();
    SyncReport { new, missing, unreachable }
}

/// Marca rutas como "no añadir" para que el seguimiento no vuelva a preguntar por ellas.
#[tauri::command]
pub fn ignore_paths(store: State<Store>, paths: Vec<String>) -> Result<()> {
    store.write(|d| {
        let mut keys: HashSet<String> = d.ignored.iter().map(|p| path_key(p)).collect();
        for p in paths {
            let p = PathBuf::from(p);
            if keys.insert(path_key(&p)) {
                d.ignored.push(p);
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_vaults(store: State<Store>, ids: Vec<String>) -> Result<usize> {
    store.write(|d| {
        let before = d.vaults.len();
        d.vaults.retain(|v| !ids.contains(&v.id));
        Ok(before - d.vaults.len())
    })
}

// ───────────────────────── Navegar un vault (solo lectura) ─────────────────────────

/// Abre el vault con las credenciales guardadas y devuelve su árbol, sin secretos.
#[tauri::command]
pub async fn open_tree(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    session: State<'_, Session>,
    prefs: State<'_, PrefsState>,
    id: String,
) -> Result<TreeView> {
    let vault = store.read(|d| d.vaults.iter().find(|v| v.id == id).cloned())?.ok_or(AppError::NotFound)?;
    // Argon2 puede tardar segundos: fuera del hilo de la interfaz.
    let db = blocking(move || vaultdb::open(&vault)).await?;
    // Si mientras tanto se bloqueó la app, el vault descifrado se descarta.
    if !store.is_unlocked() {
        return Err(AppError::Locked);
    }
    let p = prefs.get();
    let tree = vaultdb::tree(&db, p.show_vault_icons);
    session.set(id.clone(), db);
    shell::protect_window(&app, p.hide_from_capture);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = store.write(|d| {
        if let Some(v) = d.vaults.iter_mut().find(|v| v.id == id) {
            v.last_opened = Some(now);
        }
        Ok(())
    });
    Ok(tree)
}

#[tauri::command]
pub fn close_vault(app: tauri::AppHandle) {
    shell::close_vault(&app);
}

/// Todos los comandos que tocan el vault exigen la app desbloqueada, además de la sesión abierta.
fn require_unlocked(store: &Store) -> Result<()> {
    if store.is_unlocked() { Ok(()) } else { Err(AppError::Locked) }
}

/// Latido de actividad de la interfaz: evita el cierre por inactividad mientras se usa el vault.
#[tauri::command]
pub fn touch_vault(session: State<Session>, id: String) -> Result<()> {
    session.with(&id, |_| Ok(()))
}

#[tauri::command]
pub fn entry_detail(store: State<Store>, session: State<Session>, id: String, entry: String) -> Result<EntryDetail> {
    require_unlocked(&store)?;
    session.with(&id, |db| vaultdb::detail(db, &entry))
}

#[tauri::command]
pub fn entry_totp(store: State<Store>, session: State<Session>, id: String, entry: String) -> Result<TotpView> {
    require_unlocked(&store)?;
    session.with(&id, |db| vaultdb::totp(db, &entry))
}

/// Mostrar un secreto en pantalla: solo la contraseña y los campos protegidos. Lo demás ya viaja en el detalle.
#[tauri::command]
pub fn reveal_secret(
    store: State<Store>,
    session: State<Session>,
    id: String,
    entry: String,
    field: String,
) -> Result<Zeroizing<String>> {
    require_unlocked(&store)?;
    if field != "password" && !field.starts_with("custom:") {
        return Err(AppError::NotFound);
    }
    session.with(&id, |db| vaultdb::secret(db, &entry, &field))
}

/// Copia un campo al portapapeles desde Rust: el valor no pasa por la interfaz.
#[tauri::command]
pub fn copy_secret(
    store: State<Store>,
    session: State<Session>,
    prefs: State<PrefsState>,
    clipboard: State<Clipboard>,
    id: String,
    entry: String,
    field: String,
) -> Result<()> {
    require_unlocked(&store)?;
    let text = session.with(&id, |db| vaultdb::secret(db, &entry, &field))?;
    let secs = prefs.get().clipboard_clear_secs;
    clipboard.copy_secret(&text, (secs > 0).then(|| std::time::Duration::from_secs(secs as u64)))
}

/// Copia al portapapeles un informe en texto con las credenciales de las entradas elegidas, para pegarlo en
/// una herramienta de compartir secretos. El texto se construye y se copia en Rust (con las mismas
/// protecciones que «copiar»): no pasa por la interfaz. Devuelve cuántas entradas incluye.
#[tauri::command]
pub fn copy_report(
    store: State<Store>,
    session: State<Session>,
    prefs: State<PrefsState>,
    clipboard: State<Clipboard>,
    id: String,
    entries: Vec<String>,
    include_custom: bool,
    include_notes: bool,
    lang: String,
) -> Result<usize> {
    require_unlocked(&store)?;
    let opts = vaultdb::ReportOptions { include_custom, include_notes };
    let text = session.with(&id, |db| vaultdb::report(db, &entries, opts, &lang))?;
    let secs = prefs.get().clipboard_clear_secs;
    clipboard.copy_secret(&text, (secs > 0).then(|| std::time::Duration::from_secs(secs as u64)))?;
    Ok(entries.len())
}

/// Guarda un adjunto. El diálogo «Guardar como» lo abre Rust: la ruta nunca la decide la interfaz.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    session: State<'_, Session>,
    id: String,
    entry: String,
    name: String,
) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    require_unlocked(&store)?;
    let data = session.with(&id, |db| vaultdb::attachment(db, &entry, &name))?;
    let suggested = attach::safe_file_name(&name);
    blocking(move || {
        let Some(target) = app.dialog().file().set_file_name(&suggested).blocking_save_file() else {
            return Ok(false);
        };
        let path = target.into_path().map_err(|_| AppError::msg("io"))?;
        attach::write_attachment(&path, &data)?;
        Ok(true)
    })
    .await
}

/// Abre un enlace del vault en el navegador. Solo `http`, `https` y `mailto`.
#[tauri::command]
pub fn open_link(app: tauri::AppHandle, store: State<Store>, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    require_unlocked(&store)?;
    let url = attach::safe_link(&url).ok_or(AppError::msg("linkBlocked"))?;
    app.opener().open_url(url, None::<&str>).map_err(|e| AppError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ignored_vaults_are_not_proposed_again() {
        let dir = tempfile::tempdir().unwrap();
        for c in ["A", "B", "C"] {
            fs::create_dir(dir.path().join(c)).unwrap();
            fs::write(dir.path().join(c).join("x.kdbx"), b"").unwrap();
        }
        let a = dir.path().join("A").join("x.kdbx");
        let b = dir.path().join("B").join("x.kdbx");
        let c = dir.path().join("C").join("x.kdbx");
        let vault = Vault { id: "1".into(), client: "A".into(), path: a, ..Default::default() };
        let watched = [dir.path().to_path_buf()];

        // B ignorado (escrito con otra forma de la misma ruta), C pendiente.
        let alt_b = PathBuf::from(b.to_string_lossy().replace('\\', "/"));
        let r = sync_report(&[vault.clone()], &watched, &[alt_b]);
        let found: Vec<_> = r.new.iter().map(|x| x.path.clone()).collect();
        assert_eq!(found, vec![c.clone()]);

        // Sin ignorados se proponen B y C.
        assert_eq!(sync_report(&[vault], &watched, &[]).new.len(), 2);
    }
}

// ---------------------------------------------------------------------------------------------
// Exportar / importar configuración

/// Guarda todos los datos y preferencias en `path`, cifrados con la contraseña maestra actual.
#[tauri::command]
pub fn export_config(store: State<Store>, prefs: State<PrefsState>, path: String) -> Result<()> {
    let data = store.read(|d| d.clone())?;
    let plain = backup::pack(&data, &prefs.get())?;
    let blob = store.seal(&plain)?;
    std::fs::write(&path, blob)?;
    Ok(())
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Añade lo que falta; lo existente no se toca.
    Merge,
    /// Sustituye todos los datos y preferencias por los del fichero.
    Replace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Vaults nuevos (modo combinar) o total de vaults tras reemplazar.
    vaults: usize,
    /// Carpetas en seguimiento nuevas (combinar) o total tras reemplazar.
    folders: usize,
    replaced: bool,
}

/// Abre un fichero exportado con la contraseña con la que se exportó (`password`, no la actual).
#[tauri::command]
pub fn import_config(
    app: tauri::AppHandle,
    store: State<Store>,
    prefs: State<PrefsState>,
    path: String,
    password: String,
    mode: ImportMode,
) -> Result<ImportSummary> {
    let password = Zeroizing::new(password);
    let blob = std::fs::read(&path)?;
    let (_, plain) = Keys::decrypt(&password, &blob)?;
    let incoming = backup::unpack(&plain)?;

    let summary = store.write(|d| match mode {
        ImportMode::Merge => {
            let added = backup::merge(d, &incoming.data);
            Ok(ImportSummary { vaults: added.vaults, folders: added.folders, replaced: false })
        }
        ImportMode::Replace => {
            *d = incoming.data.clone();
            backup::sanitize_for_this_machine(d);
            Ok(ImportSummary { vaults: d.vaults.len(), folders: d.watched.len(), replaced: true })
        }
    })?;

    if mode == ImportMode::Replace {
        // Las preferencias vienen del otro equipo: el atajo puede no estar libre aquí, y entonces se conserva el actual.
        let current = prefs.get();
        let mut next = incoming.prefs;
        if shell::change_shortcut(&app, current.shortcut.as_deref(), next.shortcut.as_deref()).is_err() {
            let _ = shell::change_shortcut(&app, None, current.shortcut.as_deref());
            next.shortcut = current.shortcut;
        }
        prefs.update(|p| *p = next)?;
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------------------------
// Inicio automático con el sistema

use tauri_plugin_autostart::ManagerExt;

/// ¿Arranca con el sistema? La fuente de verdad es el propio sistema (registro de Windows), no un fichero nuestro.
#[tauri::command]
pub fn autostart_status(app: tauri::AppHandle) -> Result<bool> {
    app.autolaunch().is_enabled().map_err(|e| AppError::Invalid(e.to_string()))
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| AppError::Invalid(e.to_string()))?;
    al.is_enabled().map_err(|e| AppError::Invalid(e.to_string()))
}
