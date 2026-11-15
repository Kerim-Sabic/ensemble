// Ensemble's hands on Windows: a tiny helper the app talks to over stdin/stdout.
// One command per line in, one reply per line out ("ok ..." or "err ...").
// It moves the mouse, presses keys, lists windows and takes pictures of the main
// display. Written for the C# 5 compiler that ships with every Windows install.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Hands
{
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT pt; }

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int cx, int cy, int step, IntPtr brush, int flags);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint ME_MOVE = 0x0001, ME_LDOWN = 0x0002, ME_LUP = 0x0004, ME_RDOWN = 0x0008, ME_RUP = 0x0010, ME_MDOWN = 0x0020, ME_MUP = 0x0040;
    const uint ME_WHEEL = 0x0800, ME_HWHEEL = 0x1000, ME_ABSOLUTE = 0x8000;
    const uint KE_EXTENDED = 0x0001, KE_UP = 0x0002, KE_UNICODE = 0x0004;

    static int ScreenW, ScreenH;

    static int Main()
    {
        try { SetProcessDPIAware(); } catch { }
        ScreenW = GetSystemMetrics(0);
        ScreenH = GetSystemMetrics(1);
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "quit") break;
            string reply;
            try { reply = "ok " + Run(line.Split(' ')); }
            catch (Exception e) { reply = "err " + e.Message.Replace('\r', ' ').Replace('\n', ' '); }
            stdout.WriteLine(reply.TrimEnd());
        }
        return 0;
    }

    static string Run(string[] a)
    {
        switch (a[0])
        {
            case "ping": return "pong";
            case "screen":
                ScreenW = GetSystemMetrics(0);
                ScreenH = GetSystemMetrics(1);
                return ScreenW + " " + ScreenH;
            case "cursor":
                {
                    POINT p; GetCursorPos(out p);
                    return p.X + " " + p.Y;
                }
            case "move": MoveTo(Int(a[1]), Int(a[2]), true); return "";
            case "click": Click(Int(a[1]), Int(a[2]), a.Length > 3 ? a[3] : "left", a.Length > 4 ? Int(a[4]) : 1); return "";
            case "down": MoveTo(Int(a[1]), Int(a[2]), true); Button(a.Length > 3 ? a[3] : "left", true); return "";
            case "up": MoveTo(Int(a[1]), Int(a[2]), true); Button(a.Length > 3 ? a[3] : "left", false); return "";
            case "drag": Drag(Int(a[1]), Int(a[2]), Int(a[3]), Int(a[4])); return "";
            case "scroll": Scroll(Int(a[1]), Int(a[2]), Int(a[3]), Int(a[4])); return "";
            case "type": TypeText(Decode(a[1])); return "";
            case "key": Keys(Decode(a[1])); return "";
            case "shot": return Shot(Int(a[1]), Int(a[2]), Int(a[3]), Decode(a[4]));
            case "windows": return Windows();
            case "focus": return Focus(new IntPtr(long.Parse(a[1])));
            case "open": Open(Decode(a[1]), a.Length > 2 ? Decode(a[2]) : ""); return "";
            default: throw new Exception("unknown command " + a[0]);
        }
    }

    static int Int(string s) { return (int)Math.Round(double.Parse(s, System.Globalization.CultureInfo.InvariantCulture)); }
    static string Decode(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }
    static string Encode(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }

    // ───────────── input ─────────────

    static void Send(INPUT[] inputs)
    {
        uint n = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        // Windows drops input aimed at a window that runs with higher rights than we do.
        if (n == 0) throw new Exception("blocked: the window in front does not accept input from other programs (it may be running as administrator)");
    }

    static INPUT Mouse(uint flags, int dx, int dy, int data)
    {
        var i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = unchecked((uint)data); i.u.mi.dwFlags = flags;
        return i;
    }

    static void Jump(int x, int y)
    {
        x = Math.Max(0, Math.Min(ScreenW - 1, x));
        y = Math.Max(0, Math.Min(ScreenH - 1, y));
        int nx = (int)Math.Round(x * 65535.0 / Math.Max(1, ScreenW - 1));
        int ny = (int)Math.Round(y * 65535.0 / Math.Max(1, ScreenH - 1));
        Send(new[] { Mouse(ME_MOVE | ME_ABSOLUTE, nx, ny, 0) });
    }

    // The pointer glides instead of teleporting, so a person watching can follow it
    // and apps that react to hovering see it arrive.
    static void MoveTo(int x, int y, bool glide)
    {
        POINT from; GetCursorPos(out from);
        double dist = Math.Sqrt(Math.Pow(x - from.X, 2) + Math.Pow(y - from.Y, 2));
        if (glide && dist > 24)
        {
            int steps = (int)Math.Max(6, Math.Min(22, dist / 45));
            for (int i = 1; i < steps; i++)
            {
                double t = (double)i / steps;
                double e = 1 - Math.Pow(1 - t, 3);
                Jump((int)(from.X + (x - from.X) * e), (int)(from.Y + (y - from.Y) * e));
                Thread.Sleep(9);
            }
        }
        Jump(x, y);
        Thread.Sleep(25);
    }

    static void Button(string which, bool down)
    {
        uint f = which == "right" ? (down ? ME_RDOWN : ME_RUP) : which == "middle" ? (down ? ME_MDOWN : ME_MUP) : (down ? ME_LDOWN : ME_LUP);
        Send(new[] { Mouse(f, 0, 0, 0) });
    }

    static void Click(int x, int y, string which, int count)
    {
        MoveTo(x, y, true);
        Thread.Sleep(35);
        for (int i = 0; i < Math.Max(1, count); i++)
        {
            if (i > 0) Thread.Sleep(70);
            Button(which, true);
            Thread.Sleep(28);
            Button(which, false);
        }
    }

    static void Drag(int x1, int y1, int x2, int y2)
    {
        MoveTo(x1, y1, true);
        Thread.Sleep(60);
        Button("left", true);
        Thread.Sleep(120);
        int steps = 24;
        for (int i = 1; i <= steps; i++)
        {
            Jump(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
            Thread.Sleep(12);
        }
        Thread.Sleep(120);
        Button("left", false);
    }

    static void Scroll(int x, int y, int dx, int dy)
    {
        MoveTo(x, y, true);
        Thread.Sleep(30);
        int ny = Math.Abs(dy), nx = Math.Abs(dx);
        for (int i = 0; i < ny; i++) { Send(new[] { Mouse(ME_WHEEL, 0, 0, dy > 0 ? 120 : -120) }); Thread.Sleep(14); }
        for (int i = 0; i < nx; i++) { Send(new[] { Mouse(ME_HWHEEL, 0, 0, dx > 0 ? 120 : -120) }); Thread.Sleep(14); }
    }

    static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
        return i;
    }

    static void TypeText(string text)
    {
        int pause = text.Length > 400 ? 1 : 4;
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n') { Press(0x0D, false); }
            else if (c == '\t') { Press(0x09, false); }
            else Send(new[] { Key(0, c, KE_UNICODE), Key(0, c, KE_UNICODE | KE_UP) });
            Thread.Sleep(pause);
        }
    }

    static void Press(ushort vk, bool extended)
    {
        uint e = extended ? KE_EXTENDED : 0;
        Send(new[] { Key(vk, 0, e) });
        Thread.Sleep(12);
        Send(new[] { Key(vk, 0, e | KE_UP) });
    }

    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "option", 0x12 }, { "menu", 0x12 },
        { "win", 0x5B }, { "windows", 0x5B }, { "super", 0x5B }, { "cmd", 0x5B }, { "meta", 0x5B }, { "command", 0x5B },
        { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "space", 0x20 },
        { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "ins", 0x2D },
        { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "page_up", 0x21 }, { "prior", 0x21 }, { "pgup", 0x21 },
        { "pagedown", 0x22 }, { "page_down", 0x22 }, { "next", 0x22 }, { "pgdn", 0x22 },
        { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "arrowup", 0x26 }, { "arrowdown", 0x28 }, { "arrowleft", 0x25 }, { "arrowright", 0x27 },
        { "printscreen", 0x2C }, { "print", 0x2C }, { "capslock", 0x14 }, { "apps", 0x5D }, { "contextmenu", 0x5D },
        { "plus", 0xBB }, { "minus", 0xBD }, { "comma", 0xBC }, { "period", 0xBE },
    };

    static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5D };

    static bool IsModifier(ushort vk) { return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B; }

    // "ctrl+s", "alt+tab", "Return", or several in a row separated by spaces.
    static void Keys(string spec)
    {
        foreach (string combo in spec.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var mods = new List<ushort>();
            var keys = new List<ushort>();
            string rest = combo;
            // A lone "+" or a combo that ends in "+" means the plus key itself.
            var parts = new List<string>();
            if (rest == "+") parts.Add("plus");
            else
            {
                if (rest.EndsWith("++")) { rest = rest.Substring(0, rest.Length - 1) + "plus"; }
                parts.AddRange(rest.Split('+'));
            }
            foreach (string raw in parts)
            {
                string p = raw.Trim();
                if (p.Length == 0) continue;
                ushort vk;
                if (Named.TryGetValue(p.Replace("_", "").Replace("-", ""), out vk) || Named.TryGetValue(p, out vk)) { }
                else if ((p[0] == 'f' || p[0] == 'F') && p.Length > 1 && p.Length <= 3 && char.IsDigit(p[1]))
                {
                    int n = int.Parse(p.Substring(1));
                    if (n < 1 || n > 24) throw new Exception("unknown key " + p);
                    vk = (ushort)(0x70 + n - 1);
                }
                else if (p.Length == 1)
                {
                    short s = VkKeyScan(char.ToLowerInvariant(p[0]));
                    if (s == -1) throw new Exception("unknown key " + p);
                    vk = (ushort)(s & 0xFF);
                    if ((s & 0x100) != 0 && !mods.Contains(0x10)) mods.Add(0x10);
                }
                else throw new Exception("unknown key " + p);
                if (IsModifier(vk)) { if (!mods.Contains(vk)) mods.Add(vk); }
                else keys.Add(vk);
            }
            // A combo made only of modifiers ("win", "alt") presses them on their own.
            foreach (ushort m in mods) { Send(new[] { Key(m, 0, Extended.Contains(m) ? KE_EXTENDED : 0) }); Thread.Sleep(14); }
            foreach (ushort k in keys) { Press(k, Extended.Contains(k)); Thread.Sleep(14); }
            for (int i = mods.Count - 1; i >= 0; i--) { Send(new[] { Key(mods[i], 0, (Extended.Contains(mods[i]) ? KE_EXTENDED : 0) | KE_UP) }); Thread.Sleep(10); }
            Thread.Sleep(40);
        }
    }

    // ───────────── seeing ─────────────

    static ImageCodecInfo Jpeg()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        throw new Exception("no jpeg encoder");
    }

    // Saves a picture of the main display, scaled to fit, with the pointer drawn in.
    static string Shot(int maxW, int maxH, int quality, string file)
    {
        ScreenW = GetSystemMetrics(0);
        ScreenH = GetSystemMetrics(1);
        POINT cur; GetCursorPos(out cur);
        using (var full = new Bitmap(ScreenW, ScreenH, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(0, 0, 0, 0, new Size(ScreenW, ScreenH), CopyPixelOperation.SourceCopy);
                DrawCursor(g);
            }
            double s = Math.Min(1.0, Math.Min((double)maxW / ScreenW, (double)maxH / ScreenH));
            int w = Math.Max(1, (int)Math.Round(ScreenW * s)), h = Math.Max(1, (int)Math.Round(ScreenH * s));
            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(95, quality)));
            string tmp = file + ".tmp";
            if (w == ScreenW && h == ScreenH) full.Save(tmp, Jpeg(), ep);
            else
            {
                using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(small))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.CompositingQuality = CompositingQuality.HighQuality;
                        using (var attrs = new ImageAttributes())
                        {
                            attrs.SetWrapMode(WrapMode.TileFlipXY);
                            g.DrawImage(full, new Rectangle(0, 0, w, h), 0, 0, ScreenW, ScreenH, GraphicsUnit.Pixel, attrs);
                        }
                    }
                    small.Save(tmp, Jpeg(), ep);
                }
            }
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
            return w + " " + h + " " + ScreenW + " " + ScreenH + " " + cur.X + " " + cur.Y;
        }
    }

    static void DrawCursor(Graphics g)
    {
        try
        {
            var ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
            int hx = 0, hy = 0;
            ICONINFO info;
            if (GetIconInfo(ci.hCursor, out info))
            {
                hx = info.xHotspot; hy = info.yHotspot;
                if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
                if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
            }
            IntPtr hdc = g.GetHdc();
            try { DrawIconEx(hdc, ci.pt.X - hx, ci.pt.Y - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
            finally { g.ReleaseHdc(hdc); }
        }
        catch { }
    }

    // ───────────── windows ─────────────

    static string Windows()
    {
        IntPtr front = GetForegroundWindow();
        var rows = new List<string>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            int ex = GetWindowLong(h, -20);
            bool tool = (ex & 0x80) != 0, app = (ex & 0x40000) != 0;
            if (tool && !app) return true;
            if (GetWindow(h, 4) != IntPtr.Zero && !app) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
            if (cloaked != 0) return true;
            var sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            RECT r; GetWindowRect(h, out r);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            string flags = (h == front ? "f" : "") + (IsIconic(h) ? "m" : "");
            rows.Add(h.ToInt64() + "|" + proc.Replace('|', ' ').Replace(';', ' ') + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + (flags.Length == 0 ? "-" : flags) + "|" + Encode(sb.ToString()));
            return rows.Count < 60;
        }, IntPtr.Zero);
        return rows.Count + " " + string.Join(";", rows.ToArray());
    }

    static string Focus(IntPtr h)
    {
        if (!IsWindow(h)) throw new Exception("that window is gone");
        if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(180); }
        if (!SetForegroundWindow(h))
        {
            // Windows only lets the program that last received input change the front
            // window; tapping Alt counts as that input.
            try { Send(new[] { Key(0x12, 0, 0), Key(0x12, 0, KE_UP) }); } catch { }
            Thread.Sleep(40);
            SetForegroundWindow(h);
        }
        BringWindowToTop(h);
        Thread.Sleep(160);
        return GetForegroundWindow() == h ? "front" : "asked";
    }

    static void Open(string target, string args)
    {
        var psi = new ProcessStartInfo();
        psi.FileName = target;
        psi.Arguments = args;
        psi.UseShellExecute = true;
        Process.Start(psi);
    }
}
