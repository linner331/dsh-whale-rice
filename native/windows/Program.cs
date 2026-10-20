using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace WhaleOverlay
{
    /// <summary>
    /// whale-overlay: transparent, click-through, always-on-top windows (one per screen) that host the
    /// whale page outside the DeepSeek Harness window. Spawned and killed by the plugin's node half.
    ///
    ///   whale-overlay.exe --url http://127.0.0.1:&lt;port&gt;/?t=&lt;token&gt; --ppid &lt;pid&gt;
    ///
    /// The page decides what is interactive: it posts {type:"hit", rects:[[x,y,w,h],…], capture:Bool}
    /// and this process lets mouse events through everywhere else.
    /// </summary>
    internal static class Program
    {
        private static string pageUrl;
        private static int parentPid;
        private static CoreWebView2Environment environment;
        private static readonly List<OverlayWindow> windows = new List<OverlayWindow>();
        private static double unit = 1.0;

        /// <summary>Rebuilds every window after the monitor layout or a monitor's DPI changed.</summary>
        public static Action DisplayChanged = Rebuild;
        public static bool Verbose = Environment.GetEnvironmentVariable("WHALE_VERBOSE") == "1";

        [STAThread]
        private static void Main(string[] args)
        {
            pageUrl = Argument(args, "--url");
            if (string.IsNullOrEmpty(pageUrl))
            {
                Console.Error.WriteLine("usage: whale-overlay --url <url> [--ppid <pid>]");
                Environment.Exit(2);
                return;
            }
            int.TryParse(Argument(args, "--ppid") ?? "", out parentPid);

            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new OverlayApp());
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                Environment.Exit(1);
            }
        }

        private static string Argument(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        internal static void Log(string text)
        {
            try { Console.Error.WriteLine("[whale-overlay] " + text); } catch { }
        }

        private sealed class OverlayApp : ApplicationContext
        {
            private readonly Timer kickoff;
            private readonly Timer watchdog;

            public OverlayApp()
            {
                // Start once the message loop (and its WindowsForms sync context) is running, so the
                // async WebView2 calls resume on this UI thread.
                kickoff = new Timer { Interval = 40 };
                kickoff.Tick += async (s, e) =>
                {
                    kickoff.Stop();
                    kickoff.Dispose();
                    await StartAsync();
                };
                kickoff.Start();

                watchdog = new Timer { Interval = 1000 };
                watchdog.Tick += (s, e) =>
                {
                    // Exit with the DSH host even if it died without killing us.
                    if (!Native.ProcessAlive(parentPid)) ExitThread();
                };
                watchdog.Start();
            }

            private static async System.Threading.Tasks.Task StartAsync()
            {
                try
                {
                    string userData = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "dsh-whale-rice", "webview2");
                    Directory.CreateDirectory(userData);
                    environment = await CoreWebView2Environment.CreateAsync(null, userData);
                }
                catch (Exception ex)
                {
                    Log("WebView2 runtime unavailable: " + ex.Message);
                    Environment.Exit(1);
                    return;
                }
                Rebuild();
            }
        }

        /// <summary>
        /// All coordinates on Windows are physical pixels; the page works in CSS pixels of the primary
        /// monitor's scale, so each monitor's window is told where it sits in that shared space and its
        /// zoom is corrected for that monitor's own DPI (WebView2 already applies the monitor scale).
        /// </summary>
        private static void Rebuild()
        {
            foreach (var window in windows) window.Shutdown();
            windows.Clear();
            if (environment == null) return;

            Native.POINT origin = new Native.POINT { X = 0, Y = 0 };
            IntPtr primary = Native.MonitorFromPoint(origin, Native.MONITOR_DEFAULTTONEAREST);
            unit = Native.ScaleOf(primary);

            foreach (var monitor in Native.Monitors())
            {
                var window = new OverlayWindow(environment, pageUrl, monitor, unit);
                window.Start();
                windows.Add(window);
            }
            Log("overlay windows: " + windows.Count + " (unit " + unit.ToString("0.##") + ")");
        }
    }
}

