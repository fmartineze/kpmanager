; Ganchos del instalador NSIS de Tauri.
; Al desinstalar se quita el inicio automático (HKCU\...\Run), por si el usuario lo había activado en Ajustes.
; El nombre del valor es el que fija el plugin en lib.rs (`app_name("KP Manager")`).
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KP Manager"
!macroend
