using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace WhaleOverlay
{
    internal static class Native
    {
        // ---- window styles ------------------------------------------------------------------
        public const int WS_POPUP = unchecked((int)0x80000000);
        public const int WS_VISIBLE = 0x10000000;

        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        /// <summary>No GDI redirection surface: the window is composited by DirectComposition only.</summary>
        public const int WS_EX_NOREDIRECTIONBITMAP = 0x00200000;

        public const int GWL_EXSTYLE = -20;
        public const int SWP_NOSIZE = 0x0001;
        public const int SWP_NOMOVE = 0x0002;
        public const int SWP_NOZORDER = 0x0004;
        public const int SWP_NOACTIVATE = 0x0010;
        public const int SWP_FRAMECHANGED = 0x0020;
        public const int SWP_SHOWWINDOW = 0x0040;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        public const int WM_DISPLAYCHANGE = 0x007E;
        public const int WM_SETCURSOR = 0x0020;

        // ---- structs -------------------------------------------------------------------------
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;

            public int Width => Right - Left;
            public int Height => Bottom - Top;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct FrameStatistics
        {
            // Only ever passed through; the exact layout is irrelevant to us.
            public long FrameId;
            public long PresentTime;
            public long CompleteTime;
            public int PresentDuration;
            public int Padding0;
            public int SyncInterval;
            public int Padding1;
        }

        // ---- user32 / shcore / kernel32 -------------------------------------------------------
        public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")]
        public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT pt);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int key);

        public const int VK_LBUTTON = 0x01;

        /// <summary>Physical state of the left button, independent of the messages we have seen.</summary>
        public static bool LeftButtonDown()
        {
            return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        }

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);

        public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);

        [DllImport("user32.dll")]
        public static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern IntPtr SetFocus(IntPtr hwnd);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong32(IntPtr hwnd, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hwnd, int index, int value);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);

        public static int GetExStyle(IntPtr hwnd)
        {
            return IntPtr.Size == 8 ? (int)GetWindowLongPtr64(hwnd, GWL_EXSTYLE).ToInt64() : GetWindowLong32(hwnd, GWL_EXSTYLE);
        }

        public static void SetExStyle(IntPtr hwnd, int value)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, GWL_EXSTYLE, new IntPtr(value));
            else SetWindowLong32(hwnd, GWL_EXSTYLE, value);
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        /// <summary>
        /// A layered window is the one kind of top-level window whose WS_EX_TRANSPARENT is honoured
        /// across processes: without the layered style the input hit-test still lands on this window
        /// even though it has no redirection surface, and the whole screen stops being clickable.
        /// Alpha stays 255 — DirectComposition supplies the actual per-pixel transparency.
        /// </summary>
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint colorKey, byte alpha, uint flags);

        public const uint LWA_ALPHA = 0x00000002;

        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForSystem();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        public static extern uint WaitForSingleObject(IntPtr handle, uint ms);

        public static bool ProcessAlive(int pid)
        {
            if (pid <= 0) return true;
            IntPtr h = OpenProcess(0x00100000 /* SYNCHRONIZE */, false, pid);
            if (h == IntPtr.Zero) return false;
            try { return WaitForSingleObject(h, 0) == 0x00000102 /* WAIT_TIMEOUT */; }
            finally { CloseHandle(h); }
        }

        // ---- DirectComposition ---------------------------------------------------------------
        public static readonly Guid IID_IDCompositionDevice = new Guid("C37EA93A-E7AA-450D-B16F-9746CB0407F3");

        [DllImport("dcomp.dll")]
        public static extern int DCompositionCreateDevice(IntPtr dxgiDevice, ref Guid iid, out IntPtr device);

        /// <summary>Enumerates monitors in physical pixels, top-left origin of the virtual screen.</summary>
        public static List<Monitor> Monitors()
        {
            var list = new List<Monitor>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data)
            {
                var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                if (GetMonitorInfo(monitor, ref info))
                    list.Add(new Monitor { Handle = monitor, Rect = info.rcMonitor, Scale = ScaleOf(monitor) });
                return true;
            }, IntPtr.Zero);
            return list;
        }

        /// <summary>DPI scale (1.0 = 96 dpi) of the monitor that contains the point.</summary>
        public static double ScaleOf(IntPtr monitor)
        {
            uint dpiX, dpiY;
            if (GetDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, out dpiX, out dpiY) == 0 && dpiX > 0)
                return dpiX / 96.0;
            return 1.0;
        }
    }

    internal struct Monitor
    {
        public IntPtr Handle;
        public Native.RECT Rect;
        /// <summary>Device pixels per CSS pixel on this monitor (1.0 at 96 dpi).</summary>
        public double Scale;
    }

    // ---- DirectComposition COM interop -------------------------------------------------------
    // Only the leading vtable slots are declared; the rest of each interface is never called.
    [ComImport, Guid("C37EA93A-E7AA-450D-B16F-9746CB0407F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionDevice
    {
        void Commit();
        void WaitForCommitCompletion();
        void GetFrameStatistics(out Native.FrameStatistics statistics);
        void CreateTargetForHwnd(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IDCompositionTarget target);
        void CreateVisual(out IDCompositionVisual visual);
    }

    [ComImport, Guid("EACDD04C-117E-4E17-88F4-D1B12B0E3D89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionTarget
    {
        void SetRoot([MarshalAs(UnmanagedType.Interface)] IDCompositionVisual visual);
    }

    [ComImport, Guid("4D93059D-097B-4651-9A60-F0F25116E2F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionVisual
    {
        // Never called directly: the WebView2 composition controller renders into this visual.
        void SetOffsetX(float offsetX);
        void SetOffsetXAnimation([MarshalAs(UnmanagedType.Interface)] object animation);
        void SetOffsetY(float offsetY);
        void SetOffsetYAnimation([MarshalAs(UnmanagedType.Interface)] object animation);
    }

    /// <summary>A DirectComposition device + the root visual handed to WebView2 for one window.</summary>
    internal sealed class CompositionTarget
    {
        public IntPtr VisualPtr { get; private set; }
        public object Visual { get; private set; }

        private IDCompositionDevice device;
        private IDCompositionTarget target;

        /// <summary>Flushes visual changes; WebView2 hands its surface to the visual asynchronously.</summary>
        public void Commit()
        {
            try { device.Commit(); } catch (Exception ex) { Program.Log("commit failed: " + ex.Message); }
        }

        public static CompositionTarget Create(IntPtr hwnd)
        {
            Guid iid = Native.IID_IDCompositionDevice;
            IntPtr raw;
            int hr = Native.DCompositionCreateDevice(IntPtr.Zero, ref iid, out raw);
            if (hr != 0) throw new COMException("DCompositionCreateDevice failed", hr);

            var result = new CompositionTarget();
            result.device = (IDCompositionDevice)Marshal.GetObjectForIUnknown(raw);
            Marshal.Release(raw);

            result.device.CreateTargetForHwnd(hwnd, true, out result.target);
            IDCompositionVisual visual;
            result.device.CreateVisual(out visual);
            result.target.SetRoot(visual);
            result.device.Commit();

            result.Visual = visual;
            result.VisualPtr = Marshal.GetIUnknownForObject(visual);
            Marshal.Release(result.VisualPtr);
            return result;
        }
    }
}
