#ifndef MyAppVersion
#define MyAppVersion "0.0.0"
#endif

#define MyAppName "Relay Chat Dock"
#define MyAppPublisher "Milzstream"
#define MyAppExeName "relay-chat-dock.exe"

[Setup]
AppId={{7F3E2A91-8C4B-4D6E-9A11-B2C8E4F0D573}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/Milzstream/OBS-Multi-Chat
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..
OutputBaseFilename=obs-multi-chat-v{#MyAppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\app-icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no
UsedUserAreasWarning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addobsdocks"; Description: "Add Relay Chat and Relay Activity as OBS custom browser docks"; GroupDescription: "OBS:"; Flags: checked; Check: DocksNeeded

[Files]
Source: "..\deploy\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\deploy\dist\*"; DestDir: "{app}\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\deploy\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "installed.origin"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{localappdata}\{#MyAppName}"; DestName: "production.env"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\scripts\obs-docks-present.ps1"; DestDir: "{tmp}"; Flags: dontcopy nocompression

[Dirs]
Name: "{localappdata}\{#MyAppName}\data"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[UninstallDelete]
Type: files; Name: "{app}\installed.origin"

[Code]
var
  ObsDirPage: TInputDirWizardPage;

function DocksAlreadyPresent: Boolean;
var
  ResultCode: Integer;
begin
  ExtractTemporaryFile('obs-docks-present.ps1');
  Result := Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\obs-docks-present.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function DocksNeeded: Boolean;
begin
  Result := not DocksAlreadyPresent;
end;

function GetObsConfig(Param: String): String;
begin
  if Assigned(ObsDirPage) and (ObsDirPage.Values[0] <> '') then
    Result := ObsDirPage.Values[0]
  else
    Result := ExpandConstant('{userappdata}\obs-studio');
end;

procedure InitializeWizard;
begin
  ObsDirPage := CreateInputDirPage(wpSelectTasks,
    'OBS settings folder',
    'Where OBS stores Custom Browser Docks (user.ini).',
    'This is the OBS settings folder, not the Program Files install. Leave the default if it is correct. Browse if you use a portable OBS.',
    False, '');
  ObsDirPage.Add('');
  if DirExists(ExpandConstant('{userappdata}\obs-studio')) then
    ObsDirPage.Values[0] := ExpandConstant('{userappdata}\obs-studio');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if Assigned(ObsDirPage) and (PageID = ObsDirPage.ID) then
    Result := (not WizardIsTaskSelected('addobsdocks')) or DocksAlreadyPresent or DirExists(ExpandConstant('{userappdata}\obs-studio'));
end;

procedure CurStepChanged(Step: TSetupStep);
var
  ResultCode: Integer;
  Args: String;
begin
  if (Step = ssPostInstall) and WizardIsTaskSelected('addobsdocks') then
  begin
    Args := '--add-obs-docks --port 4173 --obs-config "' + GetObsConfig('') + '"';
    Exec(ExpandConstant('{app}\{#MyAppExeName}'), Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 2 then
      MsgBox('OBS Studio is running, so docks were not written (OBS overwrites that file on exit). Close OBS, then add them from Docks → Custom Browser Docks:'#13#10#13#10'http://127.0.0.1:4173/'#13#10'http://127.0.0.1:4173/activity', mbInformation, MB_OK)
    else if (ResultCode = 3) or (ResultCode = 4) then
      MsgBox('Could not find or update OBS settings. Add docks from Docks → Custom Browser Docks:'#13#10#13#10'http://127.0.0.1:4173/'#13#10'http://127.0.0.1:4173/activity', mbInformation, MB_OK);
  end;
end;
