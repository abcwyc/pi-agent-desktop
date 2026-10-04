; Tauri's NSIS installer only adds files: an overwrite install never clears
; the previous payload, so a stale resources/server/node_modules keeps
; shadowing the freshly installed one through Node's nearest-module
; resolution and crashes the server at import time (issue #72).
;
; NSIS_HOOK_PREINSTALL runs before the installer writes any file, after it
; has confirmed the app is not running. node_modules is pure payload —
; nothing writes into it at runtime — so dropping it here is always safe:
; the installer immediately writes a complete fresh tree over it.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\resources\server\node_modules"
!macroend
