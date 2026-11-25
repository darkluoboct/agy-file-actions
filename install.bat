@echo off
setlocal
set "SRC=%~dp0"
set "DST=%USERPROFILE%\.gemini\config\plugins\agy-file-actions"

echo Installing agy-file-actions to "%DST%" ...
if exist "%DST%" (
  rmdir /s /q "%DST%"
)
mkdir "%DST%"

copy /y "%SRC%plugin.json" "%DST%\plugin.json" >nul
copy /y "%SRC%mcp_config.json" "%DST%\mcp_config.json" >nul
copy /y "%SRC%README.md" "%DST%\README.md" >nul
copy /y "%SRC%LICENSE" "%DST%\LICENSE" >nul

robocopy "%SRC%assets" "%DST%\assets" /E /NFL /NDL /NJH /NJS /NC /NS >nul
robocopy "%SRC%mcp" "%DST%\mcp" /E /NFL /NDL /NJH /NJS /NC /NS >nul
robocopy "%SRC%sidecars" "%DST%\sidecars" /E /NFL /NDL /NJH /NJS /NC /NS >nul

echo Done. Your settings in "%USERPROFILE%\.gemini\config\agy-file-actions\settings.json" are preserved.
echo Open Antigravity Customizations to manage File Actions.
endlocal
