' Starts the desk supervisor (ops\supervise.mjs) without a console window. Used by the Startup shortcut and the
' 5-minute watchdog task that ops\install-autostart.cmd creates; a supervisor that already runs makes this a no-op.
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repo
sh.Run "node ops\supervise.mjs", 0, False
