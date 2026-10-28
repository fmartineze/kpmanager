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
            if let Err(e) = shell::change_shortcut(app.handle(), None, shortcut.as_deref()) {
                eprintln!("atajo global: {e}");
            }
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
            commands::set_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
