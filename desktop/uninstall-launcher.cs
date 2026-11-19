using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("WiskHarness Uninstall")]
[assembly: System.Reflection.AssemblyProduct("WiskHarness")]
[assembly: System.Reflection.AssemblyFileVersion("0.7.1.0")]
[assembly: System.Reflection.AssemblyVersion("0.7.1.0")]

internal static class UninstallLauncher
{
    private const string Version = "0.7.1";
    private const string Title = "WiskHarness Uninstall " + Version;
    private const string RegistryPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\b98c26f9-ab8f-597c-9238-bc16369cb8fb";

    [STAThread]
    private static int Main()
    {
        try
        {
            ProcessStartInfo target = FindInstalledUninstaller();
            if (target == null)
            {
                MessageBox.Show("No installed copy of WiskHarness " + Version +
                    " was found. To remove the portable app, delete its portable EXE.",
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }

            using (Process process = Process.Start(target))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("Windows could not open the WiskHarness uninstaller.\n\n" + error.Message,
                Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
    }

    private static ProcessStartInfo FindInstalledUninstaller()
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey key = root.OpenSubKey(RegistryPath))
                {
                    if (key == null || (key.GetValue("DisplayVersion") as string) != Version ||
                        (key.GetValue("DisplayName") as string) != "WiskHarness " + Version)
                        continue;

                    string command = key.GetValue("UninstallString") as string ?? "";
                    Match match = Regex.Match(command, @"^\s*""([A-Za-z]:[^""]+)""(?:\s+/(?:currentuser|allusers))?\s*$",
                        RegexOptions.IgnoreCase);
                    if (!match.Success)
                        continue;

                    string filename = Path.GetFullPath(match.Groups[1].Value);
                    if (!Path.GetFileName(filename).Equals("Uninstall WiskHarness.exe", StringComparison.OrdinalIgnoreCase))
                        continue;

                    string directory = Path.GetDirectoryName(filename);
                    string application = Path.Combine(directory, "WiskHarness.exe");
                    if (!File.Exists(filename) || !File.Exists(application))
                        continue;

                    FileVersionInfo app = FileVersionInfo.GetVersionInfo(application);
                    if (app.ProductName != "WiskHarness" ||
                        (app.ProductVersion != Version && app.ProductVersion != Version + ".0"))
                        continue;

                    return new ProcessStartInfo(filename, hive == RegistryHive.CurrentUser ? "/currentuser" : "/allusers")
                    {
                        UseShellExecute = true,
                        WorkingDirectory = directory
                    };
                }
            }
        }
        return null;
    }
}
