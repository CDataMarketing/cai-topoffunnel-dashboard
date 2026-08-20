' Starts the AI CTR dashboard server hidden (no console window).
' A copy/shortcut of this file in shell:startup makes it launch at Windows logon,
' so the bookmark artifact's "Refresh data" button always has a server to talk to.
' If a server is already running on port 3010, the new instance exits by itself.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "node server.js", 0, False
