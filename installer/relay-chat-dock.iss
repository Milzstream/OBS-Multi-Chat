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
Name: "addobsdocks"; Description: "Add Relay Chat and Relay Activity as OBS custom browser docks"; GroupDescription: "OBS:"; Check: DocksNeeded

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

[Run]
Filename: "{win}\explorer.exe"; Parameters: "/select,""{localappdata}\{#MyAppName}\production.env"""; Description: "Open production.env location"; Flags: postinstall nowait skipifsilent unchecked

[UninstallDelete]
Type: files; Name: "{app}\installed.origin"

[Code]
var
  ObsDirPage: TInputDirWizardPage;
  CredsIntro: TInputOptionWizardPage;
  TwitchPage: TInputQueryWizardPage;
  KickPage: TInputQueryWizardPage;
  YouTubePage: TInputQueryWizardPage;
  SePage: TInputQueryWizardPage;
  FirstInstall: Boolean;

function EnvFilePath: String;
begin
  Result := ExpandConstant('{localappdata}\{#MyAppName}\production.env');
end;

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

function GuideCredentials: Boolean;
begin
  Result := FirstInstall and Assigned(CredsIntro) and (CredsIntro.SelectedValue = 0);
end;

procedure OpenHintUrl(Sender: TObject);
var
  ResultCode: Integer;
begin
  ShellExec('open', TNewButton(Sender).Hint, '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
end;

procedure AddLinkButton(Page: TWizardPage; const Url, Caption: String);
var
  Button: TNewButton;
begin
  Button := TNewButton.Create(Page);
  Button.Parent := Page.Surface;
  Button.Caption := Caption;
  Button.Hint := Url;
  Button.ShowHint := True;
  Button.OnClick := @OpenHintUrl;
  Button.Width := ScaleX(210);
  Button.Height := ScaleY(23);
  Button.Left := 0;
  Button.Top := Page.SurfaceHeight - ScaleY(23);
end;

procedure ApplyEnvKey(const FileName, Key, Value: String);
var
  Lines: TArrayOfString;
  i, Count: Integer;
  Line: String;
  Found: Boolean;
begin
  if (Trim(Value) = '') or not FileExists(FileName) then
    Exit;
  LoadStringsFromFile(FileName, Lines);
  Found := False;
  Count := GetArrayLength(Lines);
  for i := 0 to Count - 1 do
  begin
    Line := Trim(Lines[i]);
    if (Length(Line) > 0) and (Line[1] <> '#') and (Copy(Line, 1, Length(Key) + 1) = Key + '=') then
    begin
      Lines[i] := Key + '=' + Trim(Value);
      Found := True;
      Break;
    end;
  end;
  if not Found then
  begin
    SetArrayLength(Lines, Count + 1);
    Lines[Count] := Key + '=' + Trim(Value);
  end;
  SaveStringsToFile(FileName, Lines, False);
end;

procedure ApplyGuidedEnv;
var
  EnvPath: String;
begin
  if not GuideCredentials then
    Exit;
  EnvPath := EnvFilePath;
  ApplyEnvKey(EnvPath, 'TWITCH_CLIENT_ID', TwitchPage.Values[0]);
  ApplyEnvKey(EnvPath, 'TWITCH_CLIENT_SECRET', TwitchPage.Values[1]);
  ApplyEnvKey(EnvPath, 'KICK_CLIENT_ID', KickPage.Values[0]);
  ApplyEnvKey(EnvPath, 'KICK_CLIENT_SECRET', KickPage.Values[1]);
  ApplyEnvKey(EnvPath, 'YOUTUBE_CLIENT_ID', YouTubePage.Values[0]);
  ApplyEnvKey(EnvPath, 'YOUTUBE_CLIENT_SECRET', YouTubePage.Values[1]);
  ApplyEnvKey(EnvPath, 'STREAMELEMENTS_JWT_TWITCH', SePage.Values[0]);
  ApplyEnvKey(EnvPath, 'STREAMELEMENTS_JWT_KICK', SePage.Values[1]);
  ApplyEnvKey(EnvPath, 'STREAMELEMENTS_JWT_YOUTUBE', SePage.Values[2]);
end;

procedure InitializeWizard;
begin
  FirstInstall := not FileExists(EnvFilePath);

  ObsDirPage := CreateInputDirPage(wpSelectTasks,
    'OBS settings folder',
    'Where OBS stores Custom Browser Docks (user.ini).',
    'This is the OBS settings folder, not the Program Files install. Leave the default if it is correct. Browse if you use a portable OBS.',
    False, '');
  ObsDirPage.Add('');
  if DirExists(ExpandConstant('{userappdata}\obs-studio')) then
    ObsDirPage.Values[0] := ExpandConstant('{userappdata}\obs-studio');

  CredsIntro := CreateInputOptionPage(wpSelectTasks,
    'API credentials',
    'Optional guided setup for a first install.',
    'Relay needs a client ID and secret per platform (Twitch, Kick, YouTube) and StreamElements JWTs for the Activity dock. Skip if you would rather paste them into production.env yourself. The finish page always shows where that file is.',
    True, False);
  CredsIntro.Add('Guide me through each provider (opens their developer page)');
  CredsIntro.Add('Skip — I will edit production.env myself');
  CredsIntro.SelectedValue := 0;

  TwitchPage := CreateInputQueryPage(CredsIntro.ID, 'Twitch', 'https://dev.twitch.tv/console/apps',
    'Create a Confidential/Private application. Set the OAuth redirect to http://localhost:4173/oauth/callback then paste the client ID and secret.');
  TwitchPage.Add('Client ID:', False);
  TwitchPage.Add('Client secret:', True);
  AddLinkButton(TwitchPage, 'https://dev.twitch.tv/console/apps', 'Open Twitch developer console');

  KickPage := CreateInputQueryPage(TwitchPage.ID, 'Kick', 'https://dev.kick.com/',
    'Create an application. Set the OAuth redirect to http://localhost:4173/oauth/callback then paste the client ID and secret.');
  KickPage.Add('Client ID:', False);
  KickPage.Add('Client secret:', True);
  AddLinkButton(KickPage, 'https://dev.kick.com/', 'Open Kick developer portal');

  YouTubePage := CreateInputQueryPage(KickPage.ID, 'YouTube / Google', 'https://console.cloud.google.com/',
    'Enable YouTube Data API v3. Create a Web application OAuth client. Authorized redirect: http://localhost:4173/oauth/callback');
  YouTubePage.Add('Client ID:', False);
  YouTubePage.Add('Client secret:', True);
  AddLinkButton(YouTubePage, 'https://console.cloud.google.com/', 'Open Google Cloud console');

  SePage := CreateInputQueryPage(YouTubePage.ID, 'StreamElements', 'https://streamelements.com/dashboard',
    'Activity dock source of truth. In the SE dashboard: avatar → switch to that platform''s channel → Show secrets. JWTs last weeks. Leave a field blank to skip that platform.');
  SePage.Add('Twitch JWT:', True);
  SePage.Add('Kick JWT:', True);
  SePage.Add('YouTube JWT:', True);
  AddLinkButton(SePage, 'https://streamelements.com/dashboard', 'Open StreamElements dashboard');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if Assigned(ObsDirPage) and (PageID = ObsDirPage.ID) then
    Result := (not WizardIsTaskSelected('addobsdocks')) or DocksAlreadyPresent or DirExists(ExpandConstant('{userappdata}\obs-studio'));
  if Assigned(CredsIntro) and (PageID = CredsIntro.ID) then
    Result := not FirstInstall;
  if Assigned(TwitchPage) and ((PageID = TwitchPage.ID) or (PageID = KickPage.ID) or (PageID = YouTubePage.ID) or (PageID = SePage.ID)) then
    Result := not GuideCredentials;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption :=
      'Relay Chat Dock is installed.'#13#10#13#10 +
      'Your environment file is:'#13#10 +
      EnvFilePath + #13#10#13#10 +
      'Edit that file if a client ID, secret, or StreamElements JWT needs to change. The same path is printed in the companion console every launch.';
end;

procedure CurStepChanged(Step: TSetupStep);
var
  ResultCode: Integer;
  Args: String;
begin
  if Step = ssPostInstall then
  begin
    ApplyGuidedEnv;
    if WizardIsTaskSelected('addobsdocks') then
    begin
      Args := '--add-obs-docks --port 4173 --obs-config "' + GetObsConfig('') + '"';
      Exec(ExpandConstant('{app}\{#MyAppExeName}'), Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      if ResultCode = 2 then
        MsgBox('OBS Studio is running, so docks were not written (OBS overwrites that file on exit). Close OBS, then add them from Docks → Custom Browser Docks:'#13#10#13#10'http://127.0.0.1:4173/'#13#10'http://127.0.0.1:4173/activity', mbInformation, MB_OK)
      else if (ResultCode = 3) or (ResultCode = 4) then
        MsgBox('Could not find or update OBS settings. Add docks from Docks → Custom Browser Docks:'#13#10#13#10'http://127.0.0.1:4173/'#13#10'http://127.0.0.1:4173/activity', mbInformation, MB_OK);
    end;
  end;
end;
