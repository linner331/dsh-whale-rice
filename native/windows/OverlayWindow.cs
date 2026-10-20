using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace WhaleOverlay
{
    [DataContract]
    internal sealed class BridgeMessage
    {
        [DataMember(Name = "type")] public string Type;
        [DataMember(Name = "text")] public string Text;
        [DataMember(Name = "capture")] public bool Capture;
        /// <summary>The region picker is open: it needs the keyboard, unlike a plain drag.</summary>
        [DataMember(Name = "editing")] public bool Editing;
        [DataMember(Name = "rects")] public List<List<double>> Rects;
    }

    /// <summary>
    /// One screen-sized, transparent, topmost window hosting the overlay page in a composition-hosted
    /// WebView2. Only the rectangles the page marks interactive accept the mouse.
    /// </summary>
    internal sealed class OverlayWindow : Form
    {
        private const int PollMs = 16;

        private readonly CoreWebView2Environment environment;
        private readonly string pageUrl;
        private readonly double unit;          // device px per global CSS px (primary monitor scale)
        private readonly double zoom;          // WebView2 zoom so that CSS px * unit == device px

        private CoreWebView2CompositionController controller;
        private CompositionTarget composition;
        private Timer timer;

        private readonly List<RectangleF> hitRects = new List<RectangleF>();   // device px, window-local
        private bool capture;
        private bool interactive;
        private bool disposed;
        private bool trackingLeave;
        private bool loggedHit;
        private long lastClickAt;
        private Point lastClickPoint;
        private bool captureMode;
        private bool editingMode;
        private int moveCount;
        /// <summary>The left button went down on the overlay and has not been released yet.</summary>
        private bool buttonDown;

        public OverlayWindow(CoreWebView2Environment environment, string baseUrl, Monitor monitor, double unit)
        {
            this.environment = environment;
            this.unit = unit;
            // WebView2 already multiplies by the monitor's DPI scale; undo it so that one global CSS
            // pixel is `unit` device pixels on every screen, matching the coordinates below.
            this.zoom = unit / monitor.Scale;

            // The page covers exactly this monitor, and is told where that monitor sits in the
            // shared global CSS-pixel space (primary scale), which is what the stored region uses.
            double sx = monitor.Rect.Left / unit;
            double sy = monitor.Rect.Top / unit;
            double sw = monitor.Rect.Width / unit;
            double sh = monitor.Rect.Height / unit;
            pageUrl = baseUrl + (baseUrl.Contains("?") ? "&" : "?")
                + "sx=" + Math.Round(sx) + "&sy=" + Math.Round(sy)
                + "&sw=" + Math.Round(sw) + "&sh=" + Math.Round(sh);

            MonitorRect = monitor.Rect;
            Log("window " + monitor.Rect.Left + "," + monitor.Rect.Top + " " + monitor.Rect.Width + "x" + monitor.Rect.Height
                + " scale " + monitor.Scale.ToString("0.##") + " zoom " + zoom.ToString("0.###")
                + " -> " + pageUrl.Substring(pageUrl.IndexOf('?')));
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            TopMost = true;
            Bounds = new Rectangle(monitor.Rect.Left, monitor.Rect.Top, monitor.Rect.Width, monitor.Rect.Height);
            BackColor = Color.Black;
            Text = "whale-overlay";
        }

        public Native.RECT MonitorRect { get; private set; }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style = Native.WS_POPUP;
                cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE | Native.WS_EX_LAYERED
                    | Native.WS_EX_NOREDIRECTIONBITMAP | Native.WS_EX_TRANSPARENT;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation => true;

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // Transparent: the DirectComposition visual tree is the only content.
        }

        protected override void OnPaint(PaintEventArgs e)
        {
        }

        public async void Start()
        {
            try
            {
                Show();
                ApplyBounds();
                Native.SetLayeredWindowAttributes(Handle, 0, 255, Native.LWA_ALPHA);
                composition = CompositionTarget.Create(Handle);

                var created = environment.CreateCoreWebView2CompositionControllerAsync(Handle);
                controller = await created;
                if (disposed) return;

                controller.Bounds = new Rectangle(0, 0, MonitorRect.Width, MonitorRect.Height);
                controller.DefaultBackgroundColor = Color.Transparent;
                controller.ZoomFactor = zoom;
                controller.IsVisible = true;
                controller.RootVisualTarget = composition.Visual;
                composition.Commit();

                var core = controller.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.WebMessageReceived += OnWebMessage;
                core.NavigationCompleted += (s, e) =>
                {
                    Log(e.IsSuccess ? "page loaded" : "page load failed: " + e.WebErrorStatus);
                    if (composition != null) composition.Commit();
                };
                core.ProcessFailed += (s, e) => Log("webview process failed: " + e.ProcessFailedKind);
                core.Navigate(pageUrl);

                timer = new Timer { Interval = PollMs };
                timer.Tick += (s, e) => Tick();
                timer.Start();
            }
            catch (Exception ex)
            {
                Log("init failed: " + ex);
                Close();
            }
        }

        /// <summary>Logs go to the stderr the plugin redirected into ~/.dsh/whale-rice/overlay.log.</summary>
        private static void Log(string text)
        {
            try { Console.Error.WriteLine("[whale-overlay] " + text); } catch { }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try { json = e.WebMessageAsJson; } catch { return; }
            BridgeMessage message;
            try
            {
                var serializer = new DataContractJsonSerializer(typeof(BridgeMessage));
                using (var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json)))
                    message = (BridgeMessage)serializer.ReadObject(stream);
            }
            catch { return; }
            if (message == null) return;

            if (message.Type == "log") { Log("page: " + message.Text); return; }
            if (message.Type != "hit") return;

            hitRects.Clear();
            if (message.Rects != null)
                foreach (var r in message.Rects)
                    if (r != null && r.Count == 4)
                        hitRects.Add(new RectangleF(
                            (float)(r[0] * unit), (float)(r[1] * unit),
                            (float)(r[2] * unit), (float)(r[3] * unit)));

            capture = message.Capture;
            // Only the region picker takes the foreground; a drag must never do it, or Windows ends
            // the mouse capture mid-drag and she is dropped where she was grabbed.
            if (message.Editing != editingMode)
            {
                editingMode = message.Editing;
                SetCaptureMode(editingMode);
            }
            if (hitRects.Count > 0 && !loggedHit)
            {
                loggedHit = true;
                var r = hitRects[0];
                Log("hit rect " + (int)r.X + "," + (int)r.Y + " " + (int)r.Width + "x" + (int)r.Height);
            }
            else if (hitRects.Count > 0 && Program.Verbose)
            {
                var r = hitRects[0];
                Log("hit " + (int)r.X + "," + (int)r.Y + " " + (int)r.Width + "x" + (int)r.Height + " capture=" + capture);
            }
        }

        /// <summary>
        /// While the user is drawing the roaming area, Escape cancels it. Region picking needs the
        /// keyboard, so the overlay takes the foreground for as long as the picker is open 閳?the same
        /// thing the macOS panel does with makeKey().
        /// </summary>
        private void SetCaptureMode(bool on)
        {
            if (captureMode == on) return;
            captureMode = on;
            if (on)
            {
                int style = Native.GetExStyle(Handle);
                Native.SetExStyle(Handle, style & ~Native.WS_EX_NOACTIVATE);
                // Region picking needs the keyboard, so the overlay takes the foreground while it
                // lasts 闂?the same thing the macOS panel does with makeKey().
                IntPtr foreground = Native.GetForegroundWindow();
                uint foregroundThread = Native.GetWindowThreadProcessId(foreground, out _);
                uint ourThread = Native.GetCurrentThreadId();
                bool attached = foregroundThread != 0 && foregroundThread != ourThread
                    && Native.AttachThreadInput(foregroundThread, ourThread, true);
                try
                {
                    Native.SetForegroundWindow(Handle);
                    Native.SetFocus(Handle);
                }
                finally
                {
                    if (attached) Native.AttachThreadInput(foregroundThread, ourThread, false);
                }
            }
            else
            {
                int style = Native.GetExStyle(Handle);
                Native.SetExStyle(Handle, style | Native.WS_EX_NOACTIVATE);
            }
        }

        private void PostKey(string key)
        {
            try
            {
                controller?.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"key\",\"key\":\"" + key + "\"}");
            }
            catch (Exception ex) { Log("post key failed: " + ex.Message); }
        }

        /// <summary>
        /// WinForms interprets a Form's Bounds in its own DPI-scaled units (a form on the 100% monitor
        /// came out 1.5x too large), so the physical rectangle is applied with SetWindowPos instead.
        /// </summary>
        private void ApplyBounds()
        {
            if (!IsHandleCreated) return;
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST,
                MonitorRect.Left, MonitorRect.Top, MonitorRect.Width, MonitorRect.Height,
                Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        private void Tick()
        {
            if (disposed || controller == null) return;

            // Safety net: if the button is physically up but we never saw its WM_LBUTTONUP (a fast
            // flick can take the pointer off the window before the up), she would stay in her hand.
            if (buttonDown && !Native.LeftButtonDown())
            {
                if (Program.Verbose) Log("safety release (button is physically up)");
                buttonDown = false;
                // The release must carry the pointer's real position: an up at the wrong point makes
                // Chromium drop the rest of the stream, which is what left her stuck in the hand.
                Native.POINT where;
                Point at = Point.Empty;
                if (Native.GetCursorPos(out where))
                    at = new Point(where.X - MonitorRect.Left, where.Y - MonitorRect.Top);
                Forward(CoreWebView2MouseEventKind.LeftButtonUp, CoreWebView2MouseEventVirtualKeys.None, 0, at);
            }

            Native.POINT cursor;
            if (!Native.GetCursorPos(out cursor)) return;
            Point local = new Point(cursor.X - MonitorRect.Left, cursor.Y - MonitorRect.Top);
            bool over = capture || buttonDown || Hit(local);

            if (over != interactive) SetInteractive(over);
            // ForwardMove keeps the button state: a move without it reads as "released" to Chromium,
            // which silently ends the drag.
            if (over) ForwardMove(local);
        }

        private bool Hit(Point local)
        {
            for (int i = 0; i < hitRects.Count; i++)
            {
                RectangleF r = hitRects[i];
                r.Inflate(2, 2);
                if (r.Contains(local.X, local.Y)) return true;
            }
            return false;
        }

        /// <summary>
        /// WS_EX_TRANSPARENT makes the whole window a hole for the mouse (cross-process), so it stays
        /// set everywhere except over the whale; the checker runs at ~60 Hz.
        /// </summary>
        private void SetInteractive(bool on)
        {
            interactive = on;
            if (Program.Verbose) Log("interactive " + on);
            int style = Native.GetExStyle(Handle);
            int next = on ? style & ~Native.WS_EX_TRANSPARENT : style | Native.WS_EX_TRANSPARENT;
            if (next != style) Native.SetExStyle(Handle, next);

            if (on)
            {
                Native.POINT cursor;
                if (Native.GetCursorPos(out cursor))
                    ForwardMove(new Point(cursor.X - MonitorRect.Left, cursor.Y - MonitorRect.Top));
            }
            else
            {
                Forward(CoreWebView2MouseEventKind.Leave, CoreWebView2MouseEventVirtualKeys.None, 0, Point.Empty);
            }
        }

        private void Forward(CoreWebView2MouseEventKind kind, CoreWebView2MouseEventVirtualKeys keys, uint data, Point point)
        {
            try { controller.SendMouseInput(kind, keys, data, point); }
            catch (Exception ex) { Log("send input failed: " + ex.Message); }
        }

        /// <summary>
        /// A move during a drag must carry the button state, otherwise Chromium believes the button
        /// was released: it ends the pointer stream and the page never sees the pointerup, which is
        /// how she ended up stuck in the user's hand after a fast move.
        /// </summary>
        private void ForwardMove(Point point)
        {
            Forward(CoreWebView2MouseEventKind.Move,
                buttonDown ? CoreWebView2MouseEventVirtualKeys.LeftButton : CoreWebView2MouseEventVirtualKeys.None,
                0, point);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case 0x0200: // WM_MOUSEMOVE
                    if (Program.Verbose && (++moveCount % 20) == 1) Log("wm_mousemove #" + moveCount + " interactive=" + interactive + " buttonDown=" + buttonDown);
                    if (interactive)
                    {
                        Point p = new Point((short)(m.LParam.ToInt64() & 0xFFFF), (short)((m.LParam.ToInt64() >> 16) & 0xFFFF));
                        // While the button is held she follows the pointer, wherever it goes.
                        if (!capture && !buttonDown && !Hit(p)) { SetInteractive(false); break; }
                        // Motion itself is forwarded from the 16 ms tick: forwarding every single
                        // message lets a 1000 Hz mouse flood the WebView2 input channel until the
                        // stream stalls mid-drag.
                        TrackLeave();
                    }
                    break;
                case 0x02A3: // WM_MOUSELEAVE
                    trackingLeave = false;
                    if (!capture && !buttonDown) SetInteractive(false);
                    break;
                case 0x0201: // WM_LBUTTONDOWN
                    {
                        // A composition-hosted WebView2 has no window of its own, so the double-click
                        // count is ours to track: the second press in time and place is reported as one.
                        Point p = ClientPoint(m.LParam);
                        buttonDown = true;
                        if (Program.Verbose) Log("button down " + p);
                        long now = Environment.TickCount;
                        bool again = now - lastClickAt < 500
                            && Math.Abs(p.X - lastClickPoint.X) <= 4 && Math.Abs(p.Y - lastClickPoint.Y) <= 4;
                        if (again)
                        {
                            Forward(CoreWebView2MouseEventKind.LeftButtonDoubleClick, CoreWebView2MouseEventVirtualKeys.LeftButton, 0, p);
                            lastClickAt = 0;
                        }
                        else
                        {
                            Forward(CoreWebView2MouseEventKind.LeftButtonDown, CoreWebView2MouseEventVirtualKeys.LeftButton, 0, p);
                            lastClickAt = now;
                            lastClickPoint = p;
                        }
                    }
                    break;
                case 0x0202: // WM_LBUTTONUP
                    if (Program.Verbose) Log("button up");
                    buttonDown = false;
                    Forward(CoreWebView2MouseEventKind.LeftButtonUp, CoreWebView2MouseEventVirtualKeys.None, 0, ClientPoint(m.LParam));
                    break;
                case 0x0215: // WM_CAPTURECHANGED: the button-up may never arrive, so release her now
                    if (Program.Verbose) Log("capture changed, buttonDown=" + buttonDown);
                    if (buttonDown)
                    {
                        buttonDown = false;
                        Forward(CoreWebView2MouseEventKind.LeftButtonUp, CoreWebView2MouseEventVirtualKeys.None, 0, Point.Empty);
                    }
                    break;
                case 0x0203: // WM_LBUTTONDBLCLK
                    Forward(CoreWebView2MouseEventKind.LeftButtonDoubleClick, CoreWebView2MouseEventVirtualKeys.LeftButton, 0, ClientPoint(m.LParam));
                    break;
                case 0x0204: // WM_RBUTTONDOWN
                    Forward(CoreWebView2MouseEventKind.RightButtonDown, CoreWebView2MouseEventVirtualKeys.RightButton, 0, ClientPoint(m.LParam));
                    break;
                case 0x0205: // WM_RBUTTONUP
                    Forward(CoreWebView2MouseEventKind.RightButtonUp, CoreWebView2MouseEventVirtualKeys.None, 0, ClientPoint(m.LParam));
                    break;
                case 0x020A: // WM_MOUSEWHEEL
                    {
                        int delta = (short)((m.WParam.ToInt64() >> 16) & 0xFFFF);
                        Native.POINT screen = new Native.POINT
                        {
                            X = (short)(m.LParam.ToInt64() & 0xFFFF),
                            Y = (short)((m.LParam.ToInt64() >> 16) & 0xFFFF),
                        };
                        Forward(CoreWebView2MouseEventKind.Wheel, CoreWebView2MouseEventVirtualKeys.None,
                            (uint)delta, new Point(screen.X - MonitorRect.Left, screen.Y - MonitorRect.Top));
                    }
                    break;
                case 0x0100: // WM_KEYDOWN
                    // The composition-hosted WebView2 gets no key messages of its own: Escape is
                    // forwarded to the page, which closes the region picker with it.
                    if (capture && (int)m.WParam == 0x1B) { PostKey("Escape"); return; }
                    break;
                case Native.WM_DISPLAYCHANGE:
                    if (Program.DisplayChanged != null) Program.DisplayChanged();
                    break;
                case 0x02E0: // WM_DPICHANGED: WinForms rescales a Form, so put it back on the monitor.
                    ApplyBounds();
                    break;
            }
            base.WndProc(ref m);
        }

        private void TrackLeave()
        {
            if (trackingLeave) return;
            trackingLeave = true;
            var tme = new TRACKMOUSEEVENT
            {
                cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(TRACKMOUSEEVENT)),
                dwFlags = 0x00000002, // TME_LEAVE
                hwndTrack = Handle,
                dwHoverTime = 0,
            };
            TrackMouseEvent(ref tme);
        }

        private static Point ClientPoint(IntPtr lParam)
        {
            long v = lParam.ToInt64();
            return new Point((short)(v & 0xFFFF), (short)((v >> 16) & 0xFFFF));
        }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct TRACKMOUSEEVENT
        {
            public int cbSize;
            public int dwFlags;
            public IntPtr hwndTrack;
            public int dwHoverTime;
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool TrackMouseEvent(ref TRACKMOUSEEVENT tme);

        public void Shutdown()
        {
            disposed = true;
            if (timer != null) { timer.Stop(); timer.Dispose(); timer = null; }
            if (controller != null)
            {
                try { controller.Close(); } catch { }
                controller = null;
            }
            Close();
        }

        protected override void Dispose(bool disposing)
        {
            disposed = true;
            base.Dispose(disposing);
        }
    }
}
