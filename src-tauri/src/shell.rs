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

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir KP Manager", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "Bloquear", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Cerrar KP Manager", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &lock, &quit])?;

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

fn parse(s: &str) -> Result<Shortcut> {
    s.parse::<Shortcut>()
        .map_err(|_| AppError::Invalid(format!("Atajo no válido: {s}")))
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
            return Err(AppError::Invalid(format!(
                "No se pudo registrar el atajo (¿lo usa otra aplicación?): {e}"
            )));
        }
    }
    Ok(())
}
