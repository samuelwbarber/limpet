# Which processes have each file open, via the Windows Restart Manager.
# Paths come in as a JSON array in LIMPET_LOCKS; out goes one JSON object
# mapping each path to the pids holding it ([] when none). main.js uses it to
# see which Codex process holds which thread-writer-locks/<thread>.lock.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
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
    public static int[] Of(string path) {
        uint session;
        if (RmStartSession(out session, 0, Guid.NewGuid().ToString()) != 0) throw new Exception("RmStartSession failed");
        try {
            if (RmRegisterResources(session, 1, new[] { path }, 0, IntPtr.Zero, 0, null) != 0) throw new Exception("RmRegisterResources failed");
            uint needed = 0, count = 0, reasons = 0;
            int rc = RmGetList(session, out needed, ref count, null, ref reasons);
            if (rc == 0) return new int[0];
            if (rc != ERROR_MORE_DATA) throw new Exception("RmGetList failed: " + rc);
            var info = new RM_PROCESS_INFO[needed];
            count = needed;
            if (RmGetList(session, out needed, ref count, info, ref reasons) != 0) throw new Exception("RmGetList failed");
            var pids = new List<int>();
            for (int i = 0; i < count; i++) pids.Add(info[i].Process.dwProcessId);
            return pids.ToArray();
        }
        finally { RmEndSession(session); }
    }
}
'@
$paths = $env:LIMPET_LOCKS | ConvertFrom-Json   # assigned first: piped, a JSON array comes out as one item
$out = [ordered]@{}
foreach ($path in $paths) {
    # A lock released (and deleted) since it was listed is held by nobody.
    try { $out[$path] = @([LimpetLockHolders]::Of($path)) } catch { $out[$path] = @() }
}
$out | ConvertTo-Json -Compress
