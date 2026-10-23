# close-others.ps1 — close duplicate top-level Live2D windows.
#
# `launch.mjs --dedupe` calls this with the pid of the window it decided to keep.
# Every other visible top-level window whose title is exactly `DSH Live2D` gets
# a WM_CLOSE, whether it belongs to an old Electron launcher (possibly with a
# different data directory), a browser app-mode fallback, or a stale process.
# Closing the window never kills the owning process tree, so a browser that also
# hosts other windows is left running.
#
# Output: one JSON line {"ok":true,"closed":[<pid>...],"failed":[<hwnd>...]}.

param(
  [Parameter(Mandatory = $true)][int]$KeeperPid,
  [string]$Title = 'DSH Live2D'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class DshLive2DWindowCloser
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private static string JsonArray(List<string> items)
    {
        if (items.Count == 0) return "[]";
        return "[\"" + string.Join("\",\"", items.ToArray()) + "\"]";
    }

    public static string CloseOthers(string title, uint keeperPid)
    {
        var seen = new List<string>();
        var closed = new List<string>();
        var failed = new List<string>();
        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var text = new StringBuilder(512);
            GetWindowText(hWnd, text, text.Capacity);
            if (!string.Equals(text.ToString(), title, StringComparison.Ordinal)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            seen.Add(pid.ToString() + ":0x" + hWnd.ToInt64().ToString("X"));
            if (pid == keeperPid) return true;

            if (PostMessage(hWnd, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero))
            {
                closed.Add(pid.ToString());
            }
            else
            {
                failed.Add("0x" + hWnd.ToInt64().ToString("X"));
            }
            return true;
        }, IntPtr.Zero);

        return "{\"ok\":true"
            + ",\"seen\":" + JsonArray(seen)
            + ",\"closed\":" + JsonArray(closed)
            + ",\"failed\":" + JsonArray(failed) + "}";
    }
}
'@

[DshLive2DWindowCloser]::CloseOthers($Title, [uint32]$KeeperPid) | Write-Output
