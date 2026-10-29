mod backup;
mod commands;
mod crypto;
mod error;
mod hello;
mod keepass;
mod model;
mod prefs;
mod scan;
mod shell;
mod store;

use directories::ProjectDirs;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Debe ir el primero: una segunda ejecución solo enfoca la ventana existente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shell::show_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Al iniciar con el sistema se pasa `--minimized`: la app arranca oculta en la bandeja.
        .plugin(tauri_plugin_autostart::Builder::new().app_name("KP Manager").args(["--minimized"]).build())
        .on_window_event(|window, event| shell::on_window_event(window, event))
        .setup(|app| {
            let dir = ProjectDirs::from("com", "kpmanager", "KPManager")
                .map(|d| d.config_dir().to_path_buf())
                .unwrap_or(app.path().app_config_dir()?);
            app.manage(store::Store::new(dir.join("vaults.enc")));
            app.manage(hello::Hello::new(dir.join("hello.bin")));
            let prefs = prefs::PrefsState::load(dir.join("prefs.json"));
            let shortcut = prefs.get().shortcut;
            app.manage(prefs);
            shell::setup_tray(app.handle())?;
            // La ventana se crea oculta (tauri.conf) y solo se muestra si no es un arranque con el sistema.
            let minimized = std::env::args().any(|a| a == "--minimized");
            if !minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            // Si el atajo no se puede registrar (p. ej. lo usa otra aplicación) no hay ventana de consola
            // donde verlo: se guarda el motivo para que la interfaz lo muestre.
            let status = shell::ShortcutStatus::default();
            let result = shell::change_shortcut(app.handle(), None, shortcut.as_deref());
            status.set(&result);
            app.manage(status);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::unlock,
            commands::lock,
            commands::change_master_password,
            commands::hello_status,
            commands::hello_enable,
            commands::hello_disable,
            commands::reset_data,
            commands::export_config,
            commands::import_config,
            commands::hello_unlock,
            commands::list_vaults,
            commands::add_vault,
            commands::update_vault,
            commands::delete_vault,
            commands::scan_folder,
            commands::import_candidates,
            commands::open_vault,
            commands::get_settings,
            commands::set_keepassxc_path,
            commands::set_default_keyfile,
            commands::detect_keepassxc,
            commands::list_watched,
            commands::clear_ignored,
            commands::add_watched,
            commands::remove_watched,
            commands::check_watched,
            commands::ignore_paths,
            commands::delete_vaults,
            commands::set_favorite,
            commands::get_prefs,
            commands::set_prefs,
            commands::set_tray_language,
            commands::ignore_update,
            commands::autostart_status,
            commands::set_autostart,
            commands::set_shortcut,
            commands::shortcut_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
