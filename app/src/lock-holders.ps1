# Which processes have each file open, via the Windows Restart Manager.
# Paths come in as a JSON array in LIMPET_LOCKS; out goes one JSON object
# mapping each path to the pids holding it ([] when none). main.js uses it to
# see which Codex process holds which thread-writer-locks/<thread>.lock (and
# which agy holds which conversation). A Restart Manager query walks every
# process's handles, so the files are asked about side by side, and the
# helper below is compiled once into %LOCALAPPDATA%\limpet (named by a hash
# of its source, so an edit here makes a fresh one).
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class LimpetLockHolders {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType; public uint AppStatus; public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nServices, string[] services);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
    const int ERROR_MORE_DATA = 234;
    // The pids holding one file; none if the file can't be asked about (gone,
    // say: a released lock is deleted).
    public static int[] Of(string path) {
        uint session;
        if (RmStartSession(out session, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
        try {
            if (RmRegisterResources(session, 1, new[] { path }, 0, IntPtr.Zero, 0, null) != 0) return new int[0];
            uint needed = 0, count = 0, reasons = 0;
            int rc = RmGetList(session, out needed, ref count, null, ref reasons);
            if (rc != ERROR_MORE_DATA) return new int[0];
            // The holder list can grow between the sizing call and this one;
            // re-size and ask again rather than report the file as free.
            RM_PROCESS_INFO[] info;
            int tries = 0;
            do {
                info = new RM_PROCESS_INFO[needed + 4];
                count = (uint)info.Length;
                rc = RmGetList(session, out needed, ref count, info, ref reasons);
            } while (rc == ERROR_MORE_DATA && ++tries < 5);
            if (rc != 0) return new int[0];
            var pids = new List<int>();
            for (int i = 0; i < count; i++) pids.Add(info[i].Process.dwProcessId);
            return pids.ToArray();
        }
        finally { RmEndSession(session); }
    }
    public static int[][] All(string[] paths) {
        var result = new int[paths.Length][];
        Parallel.For(0, paths.Length, i => { result[i] = Of(paths[i]); });
        return result;
    }
}
'@
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 12)
$dll = Join-Path $env:LOCALAPPDATA "limpet\lock-holders-$hash.dll"
if (-not (Test-Path -LiteralPath $dll)) {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dll) | Out-Null
        $tmp = "$dll.$PID.tmp"
        Add-Type -TypeDefinition $source -OutputAssembly $tmp -OutputType Library
        Move-Item -LiteralPath $tmp -Destination $dll -Force
    }
    catch { }
}
if (Test-Path -LiteralPath $dll) { Add-Type -Path $dll } else { Add-Type -TypeDefinition $source }

$paths = @($env:LIMPET_LOCKS | ConvertFrom-Json)   # PowerShell 5.1 hands a JSON array over as one item
if ($paths.Count -eq 1 -and $paths[0] -is [array]) { $paths = @($paths[0]) }
$held = [LimpetLockHolders]::All([string[]]$paths)
$out = [ordered]@{}
for ($i = 0; $i -lt $paths.Count; $i++) { $out[[string]$paths[$i]] = @($held[$i]) }
$out | ConvertTo-Json -Compress
