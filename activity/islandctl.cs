// islandctl.exe: the island's small Windows helper for live activities.
//
// Built like media/smtc.exe, with the C# compiler that ships with Windows
// (.NET Framework 4.x csc.exe), so no SDK is needed. C# 5 only: no $"", no ?.
// A GUI-subsystem exe (/target:winexe), so it never flashes a console window.
//
//   islandctl hook          Claude Code command hook. Reads the hook JSON on
//                           stdin and passes a short event to the running island
//                           over a named pipe only this Windows user can write to.
//                           Prints nothing, always exits 0, gives up at once when
//                           the island is not running: it must never slow down or
//                           break Claude Code.
//   islandctl probe         Like hook, but prints the event instead of sending it.
//   islandctl state         Prints {"quns":N,"fg":H,"fgRoot":H}: the shell's
//                           notification state (fullscreen app, presentation, quiet
//                           time) and the foreground window.
//   islandctl focus <hwnd>  Brings that window to the front. Prints ok | failed.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class IslandCtl {
  static int Main(string[] args) {
    string cmd = args.Length > 0 ? args[0] : "";
    try {
      if (cmd == "hook") Hook(false);
      else if (cmd == "probe") Hook(true);
      else if (cmd == "state") Print(State());
      else if (cmd == "focus" && args.Length > 1) Print(Focus(new IntPtr(long.Parse(args[1]))) ? "ok" : "failed");
    } catch (Exception) {
      // Never fail the caller.
    }
    return 0;
  }

  static void Print(string s) {
    using (var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) o.Write(s);
  }

  // ---- hook ------------------------------------------------------------------

  static readonly HashSet<string> Wanted = new HashSet<string> {
    "hook_event_name", "session_id", "cwd", "notification_type", "message", "tool_name", "reason", "agent_type",
  };

  static void Hook(bool probe) {
    // Read all of stdin first (Claude Code writes the whole JSON, which can be
    // large for PostToolUse) and before touching consoles below.
    string input;
    using (var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) input = r.ReadToEnd();
    var f = TopLevelStrings(input, Wanted);
    string evt = Get(f, "hook_event_name");
    string session = Get(f, "session_id");
    if (evt.Length == 0 || session.Length == 0) return;

    uint claudePid = ClaudePid();
    IntPtr hwnd = claudePid != 0 ? TerminalWindow(claudePid) : IntPtr.Zero;

    var sb = new StringBuilder();
    sb.Append("{\"v\":1,\"src\":\"claude\"");
    Field(sb, "event", evt, 40);
    Field(sb, "session", session, 100);
    Field(sb, "cwd", Get(f, "cwd"), 500);
    Field(sb, "ntype", Get(f, "notification_type"), 60);
    Field(sb, "message", Get(f, "message"), 300);
    Field(sb, "tool", Get(f, "tool_name"), 80);
    Field(sb, "reason", Get(f, "reason"), 60);
    Field(sb, "agent", Get(f, "agent_type"), 80);
    sb.Append(",\"pid\":").Append(claudePid);
    sb.Append(",\"hwnd\":").Append(hwnd.ToInt64());
    sb.Append(",\"t\":").Append((long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
    sb.Append("}");

    if (probe) Print(sb.ToString() + "\n");
    else Send(PipeName(), sb.ToString());
  }

  static string Get(Dictionary<string, string> d, string k) {
    string v;
    return d.TryGetValue(k, out v) ? v : "";
  }

  static void Field(StringBuilder sb, string name, string value, int max) {
    if (string.IsNullOrEmpty(value)) return;
    if (value.Length > max) value = value.Substring(0, max);
    sb.Append(",\"").Append(name).Append("\":\"");
    foreach (char c in value) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    sb.Append('"');
  }

  // Same name the island listens on: per Windows user.
  static string PipeName() {
    var sb = new StringBuilder();
    foreach (char c in Environment.UserName.ToLowerInvariant()) sb.Append(char.IsLetterOrDigit(c) && c < 128 ? c : '_');
    return @"\\.\pipe\island-" + sb.ToString();
  }

  static void Send(string pipe, string line) {
    byte[] data = Encoding.UTF8.GetBytes(line + "\n");
    for (int attempt = 0; attempt < 3; attempt++) {
      IntPtr h = CreateFileW(pipe, GENERIC_WRITE, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (h != INVALID_HANDLE) {
        uint written;
        WriteFile(h, data, (uint)data.Length, out written, IntPtr.Zero);
        CloseHandle(h);
        return;
      }
      // Busy: every instance is taken for a moment, wait a little. Anything
      // else (no island running) is final.
      if (Marshal.GetLastWin32Error() != ERROR_PIPE_BUSY) return;
      WaitNamedPipeW(pipe, 300);
    }
  }

  // Reads the string values of a few top-level keys and skips everything
  // else (tool_input / tool_response can be big and nested).
  static Dictionary<string, string> TopLevelStrings(string s, HashSet<string> want) {
    var d = new Dictionary<string, string>();
    int i = SkipWs(s, 0);
    if (i >= s.Length || s[i] != '{') return d;
    i++;
    while (true) {
      i = SkipWs(s, i);
      if (i >= s.Length || s[i] == '}') break;
      if (s[i] == ',') { i++; continue; }
      if (s[i] != '"') break;
      string key = ReadString(s, ref i);
      i = SkipWs(s, i);
      if (i >= s.Length || s[i] != ':') break;
      i = SkipWs(s, i + 1);
      if (i < s.Length && s[i] == '"' && want.Contains(key)) d[key] = ReadString(s, ref i);
      else i = SkipValue(s, i);
    }
    return d;
  }

  static int SkipWs(string s, int i) {
    while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    return i;
  }

  static string ReadString(string s, ref int i) {
    var sb = new StringBuilder();
    i++;
    while (i < s.Length) {
      char c = s[i++];
      if (c == '"') break;
      if (c != '\\' || i >= s.Length) { sb.Append(c); continue; }
      char e = s[i++];
      switch (e) {
        case 'n': sb.Append('\n'); break;
        case 't': sb.Append('\t'); break;
        case 'r': sb.Append('\r'); break;
        case 'b': sb.Append('\b'); break;
        case 'f': sb.Append('\f'); break;
        case 'u':
          if (i + 4 <= s.Length) { sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; }
          break;
        default: sb.Append(e); break;
      }
    }
    return sb.ToString();
  }

  static int SkipString(string s, int i) {
    i++;
    while (i < s.Length) {
      char c = s[i++];
      if (c == '\\') i++;
      else if (c == '"') break;
    }
    return i;
  }

  static int SkipValue(string s, int i) {
    if (i >= s.Length) return i;
    char c = s[i];
    if (c == '"') return SkipString(s, i);
    if (c == '{' || c == '[') {
      int depth = 0;
      while (i < s.Length) {
        char ch = s[i];
        if (ch == '"') { i = SkipString(s, i); continue; }
        if (ch == '{' || ch == '[') depth++;
        else if (ch == '}' || ch == ']') { depth--; if (depth == 0) return i + 1; }
        i++;
      }
      return i;
    }
    while (i < s.Length && s[i] != ',' && s[i] != '}' && s[i] != ']' && !char.IsWhiteSpace(s[i])) i++;
    return i;
  }

  // ---- which Claude, which window ---------------------------------------------

  static readonly HashSet<string> Shells = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "bash.exe", "sh.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe", "env.exe",
  };

  // The process that ran the hook: the first ancestor that is not a shell
  // (Claude Code spawns exec-form hooks directly, shell-form ones via a shell).
  static uint ClaudePid() {
    var parent = new Dictionary<uint, uint>();
    var name = new Dictionary<uint, string>();
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE) return 0;
    try {
      var e = new PROCESSENTRY32();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32FirstW(snap, ref e)) {
        do {
          parent[e.th32ProcessID] = e.th32ParentProcessID;
          name[e.th32ProcessID] = e.szExeFile;
        } while (Process32NextW(snap, ref e));
      }
    } finally {
      CloseHandle(snap);
    }
    uint pid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    for (int n = 0; n < 16; n++) {
      uint p;
      if (!parent.TryGetValue(pid, out p) || p == 0 || !name.ContainsKey(p)) return 0;
      pid = p;
      if (!Shells.Contains(name[pid])) return pid;
    }
    return 0;
  }

  // The terminal window Claude runs in. Its console window is the real window
  // for a classic console; in Windows Terminal it is a hidden pseudo-console
  // window owned by the terminal's window, so take the root owner.
  static IntPtr TerminalWindow(uint pid) {
    FreeConsole();
    if (AttachConsole(pid)) {
      IntPtr con = GetConsoleWindow();
      FreeConsole();
      if (con != IntPtr.Zero) {
        IntPtr root = GetAncestor(con, GA_ROOTOWNER);
        if (root != IntPtr.Zero && IsWindowVisible(root)) return root;
        if (IsWindowVisible(con)) return con;
      }
    }
    return IntPtr.Zero;
  }

  // ---- state and focus ------------------------------------------------------------

  static string State() {
    int q = 0;
    SHQueryUserNotificationState(out q);
    IntPtr fg = GetForegroundWindow();
    IntPtr root = fg == IntPtr.Zero ? IntPtr.Zero : GetAncestor(fg, GA_ROOTOWNER);
    return "{\"quns\":" + q + ",\"dnd\":" + QuietHoursProfile() + ",\"fg\":" + fg.ToInt64() + ",\"fgRoot\":" + root.ToInt64() + "}";
  }

  // Do Not Disturb / Focus assist is not part of the notification state above.
  // The shell publishes its active quiet-hours profile as a WNF state
  // (undocumented): 0 off, 1 priority only (Windows 11 Do Not Disturb),
  // 2 alarms only. -1 when it can't be read.
  static int QuietHoursProfile() {
    try {
      ulong name = 0x0D83063EA3BF1C75UL; // WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED
      byte[] buf = new byte[16];
      uint size = (uint)buf.Length;
      uint stamp;
      int status = NtQueryWnfStateData(ref name, IntPtr.Zero, IntPtr.Zero, out stamp, buf, ref size);
      if (status != 0 || size < 4) return -1;
      return BitConverter.ToInt32(buf, 0);
    } catch (Exception) {
      return -1;
    }
  }

  // Windows only lets a process take the foreground in some cases; joining the
  // input of the current foreground thread is the usual way to be allowed.
  static bool Focus(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    IntPtr fg = GetForegroundWindow();
    uint ignored;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == h;
  }

  // ---- Win32 ----------------------------------------------------------------------

  const uint GENERIC_WRITE = 0x40000000;
  const uint OPEN_EXISTING = 3;
  const int ERROR_PIPE_BUSY = 231;
  const uint TH32CS_SNAPPROCESS = 0x2;
  const uint GA_ROOTOWNER = 3;
  const int SW_RESTORE = 9;
  static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WaitNamedPipeW(string name, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteFile(IntPtr h, byte[] buffer, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("ntdll.dll")]
  static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr explicitScope, out uint changeStamp, byte[] buffer, ref uint bufferSize);
}
