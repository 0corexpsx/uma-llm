; Records the language picked in the installer, as a Windows language ID, so Uma starts in it.
; Uma reads it at startup (resolveLanguage in electron/main.cjs); a later install with another
; language switches the app again, while a choice made in Settings stays until then.
!macro customInstall
  WriteRegStr HKCU "Software\Uma LLM" "Language" "$LANGUAGE"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Uma LLM" "Language"
!macroend
