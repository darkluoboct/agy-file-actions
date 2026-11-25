@echo off
setlocal
set "DST=%USERPROFILE%\.gemini\config\plugins\agy-file-actions"

if exist "%DST%" (
  echo Removing "%DST%" ...
  rmdir /s /q "%DST%"
  echo Uninstalled agy-file-actions.
) else (
  echo agy-file-actions is not installed at "%DST%".
)
echo Note: User settings in "%USERPROFILE%\.gemini\config\agy-file-actions\settings.json" were kept.
endlocal
