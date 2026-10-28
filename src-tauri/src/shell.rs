//! Integración con el escritorio: ventana principal, bandeja del sistema y atajo global.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::error::{AppError, Result};
use crate::prefs::PrefsState;
use crate::store::Store;

/// Trae la ventana al frente (aunque esté minimizada u oculta en la bandeja) y pide enfocar el buscador.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = app.emit("focus-search", ());
    }
}

/// Textos del menú de la bandeja: (abrir, bloquear, cerrar). Cualquier idioma desconocido usa inglés.
pub fn tray_labels(language: &str) -> (&'static str, &'static str, &'static str) {
    match language {
        "es" => ("Abrir KP Manager", "Bloquear", "Cerrar KP Manager"),
        _ => ("Open KP Manager", "Lock", "Quit KP Manager"),
    }
}

/// Elementos del menú, guardados para poder cambiar su idioma sin reconstruir la bandeja.
struct TrayItems {
    open: MenuItem<tauri::Wry>,
    lock: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

pub fn set_tray_language(app: &AppHandle, language: &str) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let (open, lock, quit) = tray_labels(language);
        let _ = items.open.set_text(open);
        let _ = items.lock.set_text(lock);
        let _ = items.quit.set_text(quit);
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let (l_open, l_lock, l_quit) = tray_labels("es");
    let open = MenuItem::with_id(app, "open", l_open, true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", l_lock, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", l_quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &lock, &quit])?;
    // La interfaz fija el idioma real nada más arrancar (`set_tray_language`).
    app.manage(TrayItems { open, lock, quit });

    let mut tray = TrayIconBuilder::new()
        .tooltip("KP Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_main(app),
            "lock" => {
                app.state::<Store>().lock();
                let _ = app.emit("lock-request", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Minimizar a la bandeja: se oculta la ventana cuando pasa a minimizada, sea cual sea la vía
/// (botón propio, barra de tareas, Win+↓).
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let prefs = window.app_handle().state::<PrefsState>().get();
    // Oculta la ventana y, si está configurado, bloquea antes de que quede fuera de la vista.
    let hide = |window: &tauri::Window| {
        if prefs.lock_on_hide {
            let app = window.app_handle();
            app.state::<Store>().lock();
            let _ = app.emit("lock-request", ());
        }
        let _ = window.hide();
    };
    match event {
        WindowEvent::Resized(_) => {
            if prefs.minimize_to_tray && window.is_minimized().unwrap_or(false) {
                hide(window);
            }
        }
        // Cerrar no termina la app: sigue en la bandeja y accesible con el atajo global.
        // Salir de verdad es «Cerrar» en el menú de la bandeja (`app.exit`, que no pasa por aquí).
        WindowEvent::CloseRequested { api, .. } => {
            if prefs.close_to_tray {
                api.prevent_close();
                hide(window);
            }
        }
        _ => {}
    }
}

/// Resultado del último intento de registrar el atajo global: `None` = registrado (o sin atajo).
/// Se guarda como JSON (`{code, arg, message}`) para que la interfaz lo muestre traducido.
#[derive(Default)]
pub struct ShortcutStatus(pub std::sync::Mutex<Option<serde_json::Value>>);

impl ShortcutStatus {
    pub fn set(&self, result: &Result<()>) {
        *self.0.lock().unwrap() = result.as_ref().err().and_then(|e| serde_json::to_value(e).ok());
    }

    pub fn get(&self) -> Option<serde_json::Value> {
        self.0.lock().unwrap().clone()
    }
}

fn parse(s: &str) -> Result<Shortcut> {
    s.parse::<Shortcut>()
        .map_err(|_| AppError::msg_arg("shortcutInvalid", s))
}

/// Registra `new` y libera `old`. Si `new` no se puede registrar (p. ej. lo usa otra app), se conserva `old`.
pub fn change_shortcut(app: &AppHandle, old: Option<&str>, new: Option<&str>) -> Result<()> {
    let gs = app.global_shortcut();
    let new_sc = new.map(parse).transpose()?;
    let old_sc = old.and_then(|o| parse(o).ok());
    if let Some(o) = old_sc {
        let _ = gs.unregister(o);
    }
    if let Some(n) = new_sc {
        if let Err(e) = gs.register(n) {
            if let Some(o) = old_sc {
                let _ = gs.register(o);
            }
            return Err(AppError::msg_arg("shortcutRegister", e.to_string()));
        }
    }
    Ok(())
}
