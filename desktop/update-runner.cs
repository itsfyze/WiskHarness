using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

internal static class UpdateRunner
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void WaitForExit(int pid, int timeout)
    {
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch (ArgumentException) { return; }
        using (process)
            if (!process.WaitForExit(timeout))
                throw new IOException("WiskHarness did not close in time.");
    }

    private static void Verify(string file, string expected)
    {
        using (var input = File.OpenRead(file))
        using (var hash = SHA256.Create())
        {
            string actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "");
            if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The update checksum changed before installation.");
        }
    }

    private static Process StartApp(string target, string arguments)
    {
        var app = Process.Start(new ProcessStartInfo(target, arguments) {
            WorkingDirectory = Path.GetDirectoryName(target),
            UseShellExecute = false
        });
        if (app == null) throw new IOException("Windows did not start WiskHarness.");
        return app;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 10) return 2;
        string package = args[2], target = args[3], expected = args[4], version = args[5];
        string status = args[6], marker = args[7], stage = args[8], backup = stage + ".old";
        string restart = args[9];
        bool portable = args[1] == "portable";
        bool closed = false, replaced = false;
        Process relaunched = null;
        try
        {
            WaitForExit(Int32.Parse(args[0]), 30000);
            closed = true;
            Verify(package, expected);
            if (portable)
            {
                File.Copy(package, stage, false);
                Verify(stage, expected);
                for (int attempt = 0; ; attempt++)
                {
                    try { File.Replace(stage, target, backup, true); break; }
                    catch (IOException) { if (attempt == 59) throw; Thread.Sleep(500); }
                }
                replaced = true;
            }
            else
            {
                using (var installer = Process.Start(new ProcessStartInfo(package,
                    "/S --updated /D=" + Path.GetDirectoryName(target)) {
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(package)
                }))
                {
                    if (installer == null) throw new IOException("Windows did not start Setup.");
                    installer.WaitForExit();
                    if (installer.ExitCode != 0)
                        throw new IOException("Setup exited with code " + installer.ExitCode + ".");
                }
            }

            relaunched = StartApp(target, restart + " --wisk-update-marker=" + Quote(marker));
            for (int attempt = 0; attempt < 120; attempt++)
            {
                if (File.Exists(marker) && File.ReadAllText(marker) == version)
                {
                    File.WriteAllText(status, "success");
                    if (replaced) TryDelete(backup);
                    TryDelete(package);
                    return 0;
                }
                if (relaunched.HasExited) break;
                Thread.Sleep(500);
            }
            throw new IOException("WiskHarness did not confirm startup of version " + version + ".");
        }
        catch (Exception error)
        {
            string message = error is Win32Exception ? "Windows could not start the update: " + error.Message : error.Message;
            bool recovered = false;
            if (replaced && (relaunched == null || relaunched.HasExited))
            {
                try
                {
                    File.Replace(backup, target, null, true);
                    replaced = false;
                    message += " Restored the previous Portable executable.";
                }
                catch (Exception rollbackError) { message += "\r\n" + rollbackError.Message; }
            }
            if (replaced) message += " The previous Portable executable is saved at " + backup;
            try { File.WriteAllText(status, message); } catch (IOException) {}
            if (closed && !replaced && File.Exists(target))
            {
                try
                {
                    using (StartApp(target, restart + " --wisk-update-marker=" + Quote(marker))) {}
                    recovered = true;
                }
                catch (Exception launchError) { message += "\r\n" + launchError.Message; }
            }
            if (!recovered)
                MessageBox.Show(message, "WiskHarness update failed", MessageBoxButtons.OK, MessageBoxIcon.Error);

            return 1;
        }
        finally
        {
            if (relaunched != null) relaunched.Dispose();
            TryDelete(stage);
            TryDelete(marker);
        }
    }

    private static void TryDelete(string file)
    {
        try { File.Delete(file); } catch (IOException) {} catch (UnauthorizedAccessException) {}
    }
}
