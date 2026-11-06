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
  tags: string[];
  /** Abrir siempre directamente en KeePassXC, sin la vista dentro de la app. */
  openExternal: boolean;
}

export interface VaultInput {
  client: string;
  path: string;
  keyfile: string | null;
  password: string | null;
  clearPassword: boolean;
  tags: string[];
  openExternal: boolean;
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
  checkUpdates: boolean;
  /** Versión de la que el usuario pidió no volver a recibir avisos. */
  ignoredUpdate: string | null;
  /** Segundos hasta vaciar el portapapeles tras copiar un secreto (0 = no vaciarlo). */
  clipboardClearSecs: number;
  /** Minutos sin actividad hasta cerrar el vault abierto (0 = nunca). */
  vaultIdleMinutes: number;
  hideFromCapture: boolean;
  showVaultIcons: boolean;
  /** Cliente de las conexiones SSH. */
  sshClient: "console" | "putty";
  /** Ruta de putty.exe; la fija Rust tras elegirla en un cuadro nativo. */
  puttyPath: string | null;
}

/** Lo que se edita desde Ajustes (el atajo y la versión ignorada tienen sus propios comandos). */
export type PrefsUpdate = Omit<Prefs, "shortcut" | "ignoredUpdate" | "puttyPath">;

export type IconView = { kind: "std"; id: number } | { kind: "custom"; id: string };

export interface GroupNode {
  id: string;
  parent: string | null;
  name: string;
  icon: IconView | null;
}

export interface EntryRow {
  id: string;
  group: string;
  title: string;
  username: string;
  url: string;
  icon: IconView | null;
  tags: string[];
  hasTotp: boolean;
  hasAttachments: boolean;
}

/** El árbol del vault: nunca lleva contraseñas, notas ni semillas TOTP. */
export interface VaultTree {
  root: string;
  groups: GroupNode[];
  entries: EntryRow[];
  /** Iconos personalizados ya validados, como `data:image/png;base64,…`. */
  icons: Record<string, string>;
}

export interface FieldInfo {
  name: string;
  protected: boolean;
  value: string | null;
}

export interface EntryDetail {
  id: string;
  title: string;
  username: string;
  url: string;
  notes: string;
  tags: string[];
  hasPassword: boolean;
  hasTotp: boolean;
  fields: FieldInfo[];
  attachments: { name: string; size: number }[];
}

export interface Totp {
  code: string;
  validFor: number;
  period: number;
}

export type ImportMode = "merge" | "replace";

export interface ImportSummary {
  vaults: number;
  folders: number;
  replaced: boolean;
}

export interface HelloStatus {
  supported: boolean;
  enabled: boolean;
}

export interface DataLocation {
  path: string;
  isDefault: boolean;
  exists: boolean;
}

export type DataAction = "folder" | "existing" | "default";

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
  /** Recoge los cambios que otro equipo haya sincronizado en el fichero de datos; true si hubo alguno. */
  syncData: () => invoke<boolean>("sync_data"),
  dataLocation: () => invoke<DataLocation>("data_location"),
  /** Rust abre el cuadro de selección y aplica el cambio; null = el usuario canceló. */
  changeDataLocation: (action: DataAction, moveData: boolean) =>
    invoke<DataLocation | null>("change_data_location", { action, moveData }),
  resetData: () => invoke<void>("reset_data"),
  /** ¿La app arranca con el sistema? (lo dice el propio sistema, no un fichero nuestro) */
  autostartStatus: () => invoke<boolean>("autostart_status"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  exportConfig: (path: string) => invoke<void>("export_config", { path }),
  importConfig: (path: string, password: string, mode: ImportMode) =>
    invoke<ImportSummary>("import_config", { path, password, mode }),
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
  /** Abre el cuadro de Rust para elegir putty.exe; null si se cancela. */
  pickPutty: () => invoke<Prefs | null>("pick_putty"),
  clearPutty: () => invoke<Prefs>("clear_putty"),
  ignoreUpdate: (version: string | null) => invoke<Prefs>("ignore_update", { version }),
  setTrayLanguage: (language: Lang) => invoke<void>("set_tray_language", { language }),
  setShortcut: (shortcut: string | null) => invoke<Prefs>("set_shortcut", { shortcut }),
  /** Motivo por el que el atajo global no está activo (null = activo o sin atajo). */
  shortcutStatus: () => invoke<unknown | null>("shortcut_status"),
  openVault: (id: string) => invoke<void>("open_vault", { id }),
  openTree: (id: string) => invoke<VaultTree>("open_tree", { id }),
  closeVault: () => invoke<void>("close_vault"),
  touchVault: (id: string) => invoke<void>("touch_vault", { id }),
  entryDetail: (id: string, entry: string) => invoke<EntryDetail>("entry_detail", { id, entry }),
  entryTotp: (id: string, entry: string) => invoke<Totp>("entry_totp", { id, entry }),
  /** Mostrar en pantalla: solo `password` o `custom:<nombre>`. */
  revealSecret: (id: string, entry: string, field: string) => invoke<string>("reveal_secret", { id, entry, field }),
  /** Copia desde Rust: el valor no pasa por la interfaz. */
  copySecret: (id: string, entry: string, field: string) => invoke<void>("copy_secret", { id, entry, field }),
  /** Abre «Guardar como» en Rust; devuelve false si el usuario cancela. */
  saveAttachment: (id: string, entry: string, name: string) => invoke<boolean>("save_attachment", { id, entry, name }),
  /** Copia desde Rust un informe de texto con las credenciales de esas entradas; devuelve cuántas incluye. */
  copyReport: (id: string, entries: string[], includeCustom: boolean, includeNotes: boolean, lang: string) =>
    invoke<number>("copy_report", { id, entries, includeCustom, includeNotes, lang }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  rdpTarget: (id: string, entry: string) => invoke<string>("rdp_target", { id, entry }),
  openRdp: (id: string, entry: string, passwordField: string | null) =>
    invoke<void>("open_rdp", { id, entry, passwordField }),
  sshTarget: (id: string, entry: string) => invoke<string>("ssh_target", { id, entry }),
  openSsh: (id: string, entry: string, passwordField: string | null) =>
    invoke<void>("open_ssh", { id, entry, passwordField }),
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
