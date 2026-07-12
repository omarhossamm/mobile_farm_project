using System;
using System.IO;
using System.Text;

namespace EmulatorDesktopApp;

/// <summary>
/// Startup diagnostics that survive on Windows (WinExe → no console).
///
/// Everything written here also goes to stdout when a console is
/// attached (Mac/Linux launched from a terminal, or when the extension
/// host captures stdio pipes). On Windows GUI launches, stdout is
/// black-holed, so the file at <see cref="LogPath"/> is the only way
/// to see what happened — for example, to answer "did --auto-start
/// actually reach me?" after a bad launch.
///
/// The file is truncated on each process start so it always reflects
/// the most recent run, not accumulated history.
/// </summary>
internal static class StartupLog
{
    private static string? _logPath;
    private static readonly object _lock = new();

    /// <summary>Absolute path of the log file — populated after <see cref="Init"/>.</summary>
    public static string LogPath => _logPath ?? "";

    public static void Init()
    {
        if (_logPath != null) return;
        // WinExe → default Console.Out is a StreamWriter with AutoFlush = false;
        // if the process crashes before Avalonia even starts, our log lines
        // never make it to the parent's captured stdout. Force AutoFlush so
        // every StartupLog line becomes visible in the debug console as it's
        // written. Safe on Mac/Linux too (they usually default to AutoFlush,
        // but re-setting is a no-op).
        try
        {
            var sw = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            Console.SetOut(sw);
        }
        catch
        {
            // If stdout can't be reopened (parent didn't redirect it, or
            // the handle is closed) we still keep the file log below.
        }
        try
        {
            var dir = Path.GetTempPath();
            _logPath = Path.Combine(dir, "EmulatorDesktopApp.log");
            // Truncate so this run is what the operator sees when they open the file.
            File.WriteAllText(_logPath, $"# EmulatorDesktopApp startup log — pid {Environment.ProcessId} — {DateTime.Now:O}\n");
        }
        catch
        {
            // File-system issues must not crash the app before it even
            // starts. In-console output (Info) will still work.
            _logPath = null;
        }
    }

    public static void Info(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
        Console.WriteLine(line);
        if (_logPath == null) return;
        try
        {
            lock (_lock)
            {
                File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // Best-effort logging; never propagate an I/O failure.
        }
    }

    /// <summary>
    /// Quote a value so its boundaries are visible in the log
    /// (empty vs. whitespace vs. anything else).
    /// </summary>
    public static string Quote(string s) => s == null ? "<null>" : $"\"{s}\"";
}
