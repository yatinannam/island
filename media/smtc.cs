// smtc.exe: bridge between Windows System Media Transport Controls and the island.
//
// Built at runtime by main.js with the C# compiler that ships with Windows
// (.NET Framework 4.x csc.exe), so no SDK is needed. C# 5 only: no $"", no ?.
//
// stdout: one JSON object per line
//   {"type":"state", ...}   current session, or {"type":"state","none":true}
//   {"type":"art", "key":..., "mime":..., "data":base64 | null}
//   {"type":"error", "message":...}
// stdin: one command per line: toggle | next | prev | seek <ms>
// Exits when stdin closes, so it never outlives the app.

using System;
using System.Diagnostics;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class Smtc {
  static readonly object Gate = new object();
  static readonly object OutGate = new object();
  static GlobalSystemMediaTransportControlsSessionManager manager;
  static GlobalSystemMediaTransportControlsSession current;
  static Timer debounce;
  static string lastState;
  static string lastArtKey;

  static int Main() {
    Console.OutputEncoding = new UTF8Encoding(false);
    try {
      manager = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
    } catch (Exception e) {
      Error("RequestAsync failed: " + e.Message);
      return 1;
    }
    debounce = new Timer(delegate { Emit(); }, null, Timeout.Infinite, Timeout.Infinite);
    manager.CurrentSessionChanged += OnCurrentChanged;
    manager.SessionsChanged += OnSessionsChanged;
    PickSession();
    Emit();

    string line;
    while ((line = Console.ReadLine()) != null) {
      try { Command(line.Trim()); } catch (Exception e) { Error(line + ": " + e.Message); }
    }
    return 0;
  }

  static T Await<T>(IAsyncOperation<T> op) {
    var sw = Stopwatch.StartNew();
    while (op.Status == AsyncStatus.Started) {
      if (sw.ElapsedMilliseconds > 5000) throw new TimeoutException("WinRT call timed out");
      Thread.Sleep(2);
    }
    if (op.Status != AsyncStatus.Completed) throw new InvalidOperationException("WinRT call " + op.Status);
    return op.GetResults();
  }

  // ---- session tracking -------------------------------------------------

  static void OnCurrentChanged(GlobalSystemMediaTransportControlsSessionManager m, CurrentSessionChangedEventArgs a) {
    PickSession();
    Schedule();
  }

  static void OnSessionsChanged(GlobalSystemMediaTransportControlsSessionManager m, SessionsChangedEventArgs a) {
    PickSession();
    Schedule();
  }

  static void OnMedia(GlobalSystemMediaTransportControlsSession s, MediaPropertiesChangedEventArgs a) { Schedule(); }
  static void OnPlayback(GlobalSystemMediaTransportControlsSession s, PlaybackInfoChangedEventArgs a) { Schedule(); }
  static void OnTimeline(GlobalSystemMediaTransportControlsSession s, TimelinePropertiesChangedEventArgs a) { Schedule(); }

  // Windows' current session, or any playing session when Windows has none.
  static void PickSession() {
    lock (Gate) {
      GlobalSystemMediaTransportControlsSession next = null;
      try {
        next = manager.GetCurrentSession();
        if (next == null) {
          foreach (var s in manager.GetSessions()) {
            if (s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) { next = s; break; }
          }
        }
      } catch (Exception e) {
        Error("PickSession: " + e.Message);
      }
      if (SameSession(next, current)) return;
      if (current != null) {
        try {
          current.MediaPropertiesChanged -= OnMedia;
          current.PlaybackInfoChanged -= OnPlayback;
          current.TimelinePropertiesChanged -= OnTimeline;
        } catch (Exception) { }
      }
      current = next;
      lastArtKey = null;
      if (current != null) {
        current.MediaPropertiesChanged += OnMedia;
        current.PlaybackInfoChanged += OnPlayback;
        current.TimelinePropertiesChanged += OnTimeline;
      }
    }
  }

  static bool SameSession(GlobalSystemMediaTransportControlsSession a, GlobalSystemMediaTransportControlsSession b) {
    if (a == null || b == null) return a == b;
    try { return a.SourceAppUserModelId == b.SourceAppUserModelId; } catch (Exception) { return false; }
  }

  // Apps fire several change events per track; coalesce them.
  static void Schedule() { debounce.Change(60, Timeout.Infinite); }

  // ---- output -----------------------------------------------------------

  static void Emit() {
    lock (Gate) {
      var s = current;
      if (s == null) {
        WriteState("{\"type\":\"state\",\"none\":true}");
        lastArtKey = null;
        return;
      }
      try {
        var props = Await(s.TryGetMediaPropertiesAsync());
        var playback = s.GetPlaybackInfo();
        var timeline = s.GetTimelineProperties();
        var controls = playback.Controls;

        long updated = 0;
        try { updated = timeline.LastUpdatedTime.ToUnixTimeMilliseconds(); } catch (Exception) { }
        var duration = timeline.EndTime - timeline.StartTime;
        var position = timeline.Position - timeline.StartTime;

        var sb = new StringBuilder(256);
        sb.Append("{\"type\":\"state\"");
        Field(sb, "app", s.SourceAppUserModelId);
        Field(sb, "title", props.Title);
        Field(sb, "artist", props.Artist);
        Field(sb, "album", props.AlbumTitle);
        Field(sb, "status", playback.PlaybackStatus.ToString().ToLowerInvariant());
        sb.Append(",\"position\":").Append((long)position.TotalMilliseconds);
        sb.Append(",\"duration\":").Append((long)duration.TotalMilliseconds);
        sb.Append(",\"updatedAt\":").Append(updated);
        Flag(sb, "canToggle", controls.IsPlayPauseToggleEnabled);
        Flag(sb, "canNext", controls.IsNextEnabled);
        Flag(sb, "canPrev", controls.IsPreviousEnabled);
        Flag(sb, "canSeek", controls.IsPlaybackPositionEnabled);
        sb.Append('}');
        WriteState(sb.ToString());

        string artKey = s.SourceAppUserModelId + "|" + props.Title + "|" + props.Artist + "|" + props.AlbumTitle;
        if (artKey != lastArtKey) EmitArt(props, artKey);
      } catch (Exception e) {
        Error("Emit: " + e.Message);
      }
    }
  }

  static void EmitArt(GlobalSystemMediaTransportControlsSessionMediaProperties props, string key) {
    string data = null, mime = null;
    try {
      if (props.Thumbnail != null) {
        var stream = Await(props.Thumbnail.OpenReadAsync());
        var size = (uint)stream.Size;
        if (size > 0 && size < 8 * 1024 * 1024) {
          var reader = new DataReader(stream);
          Await(reader.LoadAsync(size));
          var bytes = new byte[size];
          reader.ReadBytes(bytes);
          data = Convert.ToBase64String(bytes);
          mime = stream.ContentType;
        }
      }
    } catch (Exception e) {
      Error("art: " + e.Message);
    }
    // Some apps publish the title before the artwork; retry on the next event.
    if (data != null) lastArtKey = key;
    var sb = new StringBuilder(data == null ? 128 : data.Length + 128);
    sb.Append("{\"type\":\"art\"");
    Field(sb, "key", key);
    Field(sb, "mime", mime);
    Field(sb, "data", data);
    sb.Append('}');
    Write(sb.ToString());
  }

  static void WriteState(string json) {
    if (json == lastState) return;
    lastState = json;
    Write(json);
  }

  static void Error(string message) {
    var sb = new StringBuilder();
    sb.Append("{\"type\":\"error\"");
    Field(sb, "message", message);
    sb.Append('}');
    Write(sb.ToString());
  }

  static void Write(string line) {
    lock (OutGate) {
      Console.Out.Write(line);
      Console.Out.Write('\n');
      Console.Out.Flush();
    }
  }

  static void Flag(StringBuilder sb, string name, bool value) {
    sb.Append(",\"").Append(name).Append("\":").Append(value ? "true" : "false");
  }

  static void Field(StringBuilder sb, string name, string value) {
    sb.Append(",\"").Append(name).Append("\":");
    if (value == null) { sb.Append("null"); return; }
    sb.Append('"');
    foreach (char c in value) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
          else sb.Append(c);
          break;
      }
    }
    sb.Append('"');
  }

  // ---- commands ---------------------------------------------------------

  static void Command(string line) {
    if (line.Length == 0) return;
    GlobalSystemMediaTransportControlsSession s;
    lock (Gate) { s = current; }
    if (s == null) return;
    var parts = line.Split(' ');
    switch (parts[0]) {
      case "toggle": Await(s.TryTogglePlayPauseAsync()); break;
      case "next": Await(s.TrySkipNextAsync()); break;
      case "prev": Await(s.TrySkipPreviousAsync()); break;
      case "seek":
        long ms;
        if (parts.Length > 1 && long.TryParse(parts[1], out ms) && ms >= 0) {
          Await(s.TryChangePlaybackPositionAsync(ms * 10000));
        }
        break;
      default: Error("unknown command " + parts[0]); break;
    }
    Schedule();
  }
}
