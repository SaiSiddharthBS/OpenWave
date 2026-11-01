; Inno Setup script: builds OpenWave-Windows-Setup.exe.
; Installs per-user (no admin prompt), adds Start menu + desktop shortcuts and an uninstaller.
#define AppVersion GetEnv("OPENWAVE_VERSION")

[Setup]
AppId={{6E1A7C2B-3D4F-4E8A-9B1C-0FEA0A11CE55}
AppName=OpenWave
AppVersion={#AppVersion}
AppPublisher=OpenWave contributors
AppPublisherURL=https://github.com/SaiSiddharthBS/OpenWave
DefaultDirName={localappdata}\Programs\OpenWave
DefaultGroupName=OpenWave
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=OpenWave-Windows-Setup
SetupIconFile=openwave.ico
UninstallDisplayIcon={app}\OpenWave.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile=..\..\LICENSE

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\..\dist\OpenWave\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\OpenWave"; Filename: "{app}\OpenWave.exe"
Name: "{autodesktop}\OpenWave"; Filename: "{app}\OpenWave.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\OpenWave.exe"; Description: "Start OpenWave"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; "Start with Windows" may have it running in the background: stop it so its files can go.
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im OpenWave.exe"; Flags: runhidden; RunOnceId: "StopOpenWave"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'OpenWave');
end;
