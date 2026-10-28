use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::hello::{self, Hello};
use crate::keepass;
use crate::prefs::{Prefs, PrefsState};
use crate::shell;
use crate::model::{Executable, Vault};
use crate::scan::{self, Candidate, is_under, path_key};
use crate::store::Store;

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
}

impl VaultInput {
    fn validate(&self) -> Result<()> {
        if self.client.trim().is_empty() || self.path.trim().is_empty() {
            return Err(AppError::Invalid("Cliente y ruta son obligatorios".into()));
        }
        Ok(())
    }

    fn apply(self, v: &mut Vault) {
        v.client = self.client.trim().to_owned();
        v.path = PathBuf::from(self.path.trim());
        v.keyfile = self.keyfile.filter(|k| !k.trim().is_empty()).map(PathBuf::from);
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
pub fn lock(store: State<Store>) {
    store.lock();
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

/// Autentica con Windows Hello y desbloquea. Si falla, la UI cae a la contraseña maestra.
#[tauri::command]
pub async fn hello_unlock(store: State<'_, Store>, hello: State<'_, Hello>) -> Result<()> {
    let h = hello.inner().clone();
    let password = blocking(move || h.unlock()).await?;
    match store.unlock(&password) {
        Err(AppError::WrongPassword) => {
            hello.disable();
            Err(AppError::Invalid("La contraseña maestra guardada ya no es válida. Usa la contraseña".into()))
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
        return Err(AppError::Invalid("La carpeta no existe".into()));
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

#[tauri::command]
pub fn set_prefs(
    prefs: State<PrefsState>,
    minimize_to_tray: bool,
    close_to_tray: bool,
    lock_on_hide: bool,
    sort_by_name: bool,
) -> Result<Prefs> {
    prefs.update(|p| {
        p.minimize_to_tray = minimize_to_tray;
        p.close_to_tray = close_to_tray;
        p.lock_on_hide = lock_on_hide;
        p.sort_by_name = sort_by_name;
    })
}

/// `None` o vacío quita el atajo global. Si no se puede registrar, el anterior se conserva.
#[tauri::command]
pub fn set_shortcut(app: tauri::AppHandle, prefs: State<PrefsState>, shortcut: Option<String>) -> Result<Prefs> {
    let shortcut = shortcut.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let old = prefs.get().shortcut;
    shell::change_shortcut(&app, old.as_deref(), shortcut.as_deref())?;
    prefs.update(|p| p.shortcut = shortcut)
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
                return Err(AppError::Invalid("La keyfile no existe".into()));
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
                return Err(AppError::Invalid("El ejecutable no existe".into()));
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
        return Err(AppError::Invalid("La carpeta no existe".into()));
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
