import { invoke } from "@tauri-apps/api/core";
import { errorText, type Lang, type LangPref } from "./i18n";
import type { ThemePref } from "./theme";

export interface Vault {
  id: string;
  client: string;
  path: string;
  keyfile: string | null;
  hasPassword: boolean;
  favorite: boolean;
  lastOpened: number | null;
}

export interface VaultInput {
  client: string;
  path: string;
  keyfile: string | null;
  password: string | null;
  clearPassword: boolean;
}

export interface Candidate {
  client: string;
  path: string;
  already: boolean;
  ignored: boolean;
}

export interface Status {
  exists: boolean;
  unlocked: boolean;
}

export interface Prefs {
  shortcut: string | null;
  minimizeToTray: boolean;
  closeToTray: boolean;
  lockOnHide: boolean;
  sortByName: boolean;
  theme: ThemePref;
  language: LangPref;
}

/** Lo que se edita desde Ajustes (el atajo global tiene su propio comando). */
export type PrefsUpdate = Omit<Prefs, "shortcut">;

export interface HelloStatus {
  supported: boolean;
  enabled: boolean;
}

export interface Settings {
  keepassxcPath: string | null;
  defaultKeyfile: string | null;
}

export interface WatchedFolder {
  path: string;
  reachable: boolean;
  vaults: number;
}

export interface WatchedView {
  folders: WatchedFolder[];
  ignoredCount: number;
}

export interface SyncReport {
  new: Candidate[];
  missing: Vault[];
  unreachable: string[];
}

export const api = {
  status: () => invoke<Status>("status"),
  unlock: (password: string) => invoke<void>("unlock", { password }),
  lock: () => invoke<void>("lock"),
  helloStatus: () => invoke<HelloStatus>("hello_status"),
  helloEnable: (password: string) => invoke<void>("hello_enable", { password }),
  helloDisable: () => invoke<void>("hello_disable"),
  /** Borra todos los datos cifrados; la app vuelve al primer uso. */
  resetData: () => invoke<void>("reset_data"),
  helloUnlock: () => invoke<void>("hello_unlock"),
  changeMasterPassword: (password: string) => invoke<void>("change_master_password", { password }),
  listVaults: () => invoke<Vault[]>("list_vaults"),
  addVault: (input: VaultInput) => invoke<Vault>("add_vault", { input }),
  updateVault: (id: string, input: VaultInput) => invoke<Vault>("update_vault", { id, input }),
  deleteVault: (id: string) => invoke<void>("delete_vault", { id }),
  scanFolder: (path: string) => invoke<Candidate[]>("scan_folder", { path }),
  importCandidates: (items: { client: string; path: string }[]) =>
    invoke<number>("import_candidates", { items }),
  setFavorite: (id: string, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  getPrefs: () => invoke<Prefs>("get_prefs"),
  setPrefs: (update: PrefsUpdate) => invoke<Prefs>("set_prefs", { update }),
  setTrayLanguage: (language: Lang) => invoke<void>("set_tray_language", { language }),
  setShortcut: (shortcut: string | null) => invoke<Prefs>("set_shortcut", { shortcut }),
  /** Motivo por el que el atajo global no está activo (null = activo o sin atajo). */
  shortcutStatus: () => invoke<unknown | null>("shortcut_status"),
  openVault: (id: string) => invoke<void>("open_vault", { id }),
  getSettings: () => invoke<Settings>("get_settings"),
  setKeepassxcPath: (path: string | null) => invoke<Settings>("set_keepassxc_path", { path }),
  setDefaultKeyfile: (path: string | null) => invoke<Settings>("set_default_keyfile", { path }),
  detectKeepassxc: () => invoke<Settings>("detect_keepassxc"),
  listWatched: () => invoke<WatchedView>("list_watched"),
  clearIgnored: () => invoke<void>("clear_ignored"),
  addWatched: (path: string) => invoke<void>("add_watched", { path }),
  removeWatched: (path: string) => invoke<void>("remove_watched", { path }),
  checkWatched: () => invoke<SyncReport>("check_watched"),
  ignorePaths: (paths: string[]) => invoke<void>("ignore_paths", { paths }),
  deleteVaults: (ids: string[]) => invoke<number>("delete_vaults", { ids }),
};

export const errMsg = errorText;
