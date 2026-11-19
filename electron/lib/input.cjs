// Mouse and keyboard for the model, when the user allows "Control the mouse and keyboard".
// Coordinates are those of the whole-screen picture from look_at_screen (at most 1280 wide), turned
// into real screen positions here, so what the model points at in the picture is what gets clicked.
//
// Windows: one PowerShell process with a small C# class that calls SendInput (no extra software).
// macOS: osascript (JavaScript for Automation and System Events); Uma needs Accessibility access.
// Linux: xdotool, when it is installed.
//
// Safety: every action first checks the pointer. If the user has pushed it into the top-left corner
// of the screen, everything stops (as with a dead man's switch); halt() stops it too and refuses
// further actions until the next request.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');

// The model sees the screen at most this wide (capture.cjs, MODEL_WIDTH).
const MODEL_WIDTH = 1280;
const CORNER = 3;

const WINDOWS_HOST = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') -contains $_.GetName().Name } | ForEach-Object { $_.Location }
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public static class UmaInput {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  const uint MOUSE = 0, KEYBOARD = 1;
  const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

  public static void Init() { SetProcessDPIAware(); }

  static void Send(INPUT input) { SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = MOUSE; i.u.mi.dwFlags = flags; i.u.mi.mouseData = (uint)data; Send(i); }
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90; }
  static void Key(ushort vk, bool up) { INPUT i = new INPUT(); i.type = KEYBOARD; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? KEYUP : 0) | (Extended(vk) ? EXTENDED : 0); Send(i); }
  static void Char(char c) {
    INPUT down = new INPUT(); down.type = KEYBOARD; down.u.ki.wScan = c; down.u.ki.dwFlags = UNICODE; Send(down);
    INPUT up = new INPUT(); up.type = KEYBOARD; up.u.ki.wScan = c; up.u.ki.dwFlags = UNICODE | KEYUP; Send(up);
  }

  static readonly Dictionary<string, ushort> Names = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"win",0x5B},{"windows",0x5B},{"meta",0x5B},{"cmd",0x5B},{"super",0x5B},
    {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},{"space",0x20},{"spacebar",0x20},{"backspace",0x08},
    {"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pgup",0x21},{"pagedown",0x22},{"pgdn",0x22},
    {"left",0x25},{"up",0x26},{"right",0x27},{"down",0x28},{"capslock",0x14},{"printscreen",0x2C},{"menu",0x5D},
    {"playpause",0xB3},{"play",0xB3},{"pause",0xB3},{"nexttrack",0xB0},{"prevtrack",0xB1},{"stop",0xB2},{"mute",0xAD},{"volumeup",0xAF},{"volumedown",0xAE}
  };

  static ushort Vk(string name) {
    ushort code;
    if (Names.TryGetValue(name, out code)) return code;
    if (name.Length > 1 && (name[0] == 'f' || name[0] == 'F')) { int n; if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n); }
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
      short scan = VkKeyScan(name[0]);
      if (scan != -1) return (ushort)(scan & 0xFF);
    }
    throw new Exception("Unknown key: " + name);
  }

  static string Decode(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }

  // The named things a window offers (links, buttons, fields...), from Windows UI Automation: in a
  // browser, the page's own items. Each line: type, x, y, width, height (screen pixels), name.
  static string Items(IntPtr h) {
    AutomationElement win = AutomationElement.FromHandle(h);
    PropertyCondition isDocument = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
    AutomationElement doc = win.FindFirst(TreeScope.Descendants, isDocument);
    // A browser builds the page's tree only once something asks for it: ask again for a moment.
    StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
    for (int wait = 0; doc == null && wait < 6 && cls.ToString().StartsWith("Chrome_WidgetWin"); wait++) {
      Thread.Sleep(300);
      doc = win.FindFirst(TreeScope.Descendants, isDocument);
    }
    AutomationElement scope = doc ?? win;
    ControlType[] kinds = { ControlType.Hyperlink, ControlType.Button, ControlType.Edit, ControlType.CheckBox, ControlType.RadioButton, ControlType.MenuItem, ControlType.TabItem, ControlType.ComboBox, ControlType.ListItem };
    Condition[] any = new Condition[kinds.Length];
    for (int k = 0; k < kinds.Length; k++) any[k] = new PropertyCondition(AutomationElement.ControlTypeProperty, kinds[k]);
    AutomationElementCollection all = scope.FindAll(TreeScope.Descendants, new OrCondition(any));
    List<string> found = new List<string>();
    foreach (AutomationElement e in all) {
      try {
        AutomationElement.AutomationElementInformation c = e.Current;
        // Items below the fold (a page's footer, its contact form) are kept, marked: the model can
        // still find them by name, and a click scrolls them into view first.
        bool hidden = c.IsOffscreen;
        System.Windows.Rect r = c.BoundingRectangle;
        if (!hidden && (r.IsEmpty || r.Width < 3 || r.Height < 3)) continue;
        string name = (c.Name ?? "").Trim();
        if (name.Length == 0) continue;
        string kind = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
        int x = r.IsEmpty ? 0 : (int)r.X, y = r.IsEmpty ? 0 : (int)r.Y, w = r.IsEmpty ? 0 : (int)r.Width, hh = r.IsEmpty ? 0 : (int)r.Height;
        found.Add(Convert.ToBase64String(Encoding.UTF8.GetBytes(kind + "\t" + x + "\t" + y + "\t" + w + "\t" + hh + "\t" + (hidden ? "1" : "0") + "\t" + name)));
        if (found.Count >= 800) break;
      } catch { }
    }
    return string.Join(" ", found.ToArray());
  }

  static IntPtr FindWindow(string wanted) {
    IntPtr found = IntPtr.Zero;
    string lower = wanted.ToLowerInvariant();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      if (title.Length > 0 && title.ToString().ToLowerInvariant().Contains(lower)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Run(string line) {
    string[] a = line.Split('\t');
    switch (a[0]) {
      case "pos": { POINT p; GetCursorPos(out p); return "OK " + p.X + " " + p.Y; }
      case "move": SetCursorPos(int.Parse(a[1]), int.Parse(a[2])); return "OK";
      case "click": {
        SetCursorPos(int.Parse(a[1]), int.Parse(a[2])); Thread.Sleep(40);
        uint down = a[3] == "right" ? RIGHTDOWN : a[3] == "middle" ? MIDDLEDOWN : LEFTDOWN;
        uint up = a[3] == "right" ? RIGHTUP : a[3] == "middle" ? MIDDLEUP : LEFTUP;
        int count = int.Parse(a[4]);
        for (int n = 0; n < count; n++) { Mouse(down, 0); Thread.Sleep(30); Mouse(up, 0); Thread.Sleep(60); }
        return "OK";
      }
      case "scroll": SetCursorPos(int.Parse(a[1]), int.Parse(a[2])); Thread.Sleep(30); Mouse(WHEEL, -120 * int.Parse(a[3])); return "OK";
      case "drag": {
        int x1 = int.Parse(a[1]), y1 = int.Parse(a[2]), x2 = int.Parse(a[3]), y2 = int.Parse(a[4]);
        SetCursorPos(x1, y1); Thread.Sleep(40); Mouse(LEFTDOWN, 0); Thread.Sleep(80);
        for (int s = 1; s <= 20; s++) { SetCursorPos(x1 + (x2 - x1) * s / 20, y1 + (y2 - y1) * s / 20); Thread.Sleep(12); }
        Thread.Sleep(60); Mouse(LEFTUP, 0); return "OK";
      }
      case "type": {
        foreach (char c in Decode(a[1])) {
          if (c == '\n') { Key(0x0D, false); Key(0x0D, true); }
          else if (c == '\t') { Key(0x09, false); Key(0x09, true); }
          else if (c != '\r') Char(c);
          Thread.Sleep(8);
        }
        return "OK";
      }
      case "keys": {
        foreach (string combo in Decode(a[1]).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
          string[] parts = combo.Split('+');
          List<ushort> codes = new List<ushort>();
          foreach (string part in parts) codes.Add(Vk(part.Trim()));
          foreach (ushort vk in codes) { Key(vk, false); Thread.Sleep(15); }
          for (int k = codes.Count - 1; k >= 0; k--) { Key(codes[k], true); Thread.Sleep(15); }
          Thread.Sleep(40);
        }
        return "OK";
      }
      case "reveal": {
        // Brings the item with exactly that name into view: scrolling it there, or giving it the focus.
        IntPtr hw = a.Length > 2 && a[2].Length > 0 ? FindWindow(Decode(a[2])) : GetForegroundWindow();
        if (hw == IntPtr.Zero) return "ERR No open window has that text in its title.";
        AutomationElement root = AutomationElement.FromHandle(hw);
        AutomationElement target = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, Decode(a[1])));
        if (target == null) return "ERR Not found.";
        object pattern;
        if (target.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) { try { ((ScrollItemPattern)pattern).ScrollIntoView(); } catch { } }
        try { if (target.Current.IsOffscreen && target.Current.IsKeyboardFocusable) target.SetFocus(); } catch { }
        return "OK";
      }
      case "items": {
        IntPtr h = a.Length > 1 && a[1].Length > 0 ? FindWindow(Decode(a[1])) : GetForegroundWindow();
        if (h == IntPtr.Zero) return "ERR No open window has that text in its title.";
        return "OK " + Items(h);
      }
      case "windows": {
        List<string> titles = new List<string>();
        EnumWindows((h, l) => {
          if (!IsWindowVisible(h)) return true;
          StringBuilder title = new StringBuilder(512);
          GetWindowText(h, title, 512);
          if (title.Length > 0) titles.Add(Convert.ToBase64String(Encoding.UTF8.GetBytes(title.ToString())));
          return true;
        }, IntPtr.Zero);
        return "OK " + string.Join(" ", titles);
      }
      case "focus": {
        IntPtr h = FindWindow(Decode(a[1]));
        if (h == IntPtr.Zero) return "ERR No open window has that text in its title.";
        if (IsIconic(h)) ShowWindow(h, 9);
        // Windows only lets a program bring a window forward right after a key press.
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
        StringBuilder title = new StringBuilder(512); GetWindowText(h, title, 512);
        return "OK " + title.ToString();
      }
    }
    return "ERR Unknown action.";
  }
}
'@
[UmaInput]::Init()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $answer = [UmaInput]::Run($line) } catch { $answer = 'ERR ' + $_.Exception.Message }
  [Console]::Out.WriteLine($answer)
  [Console]::Out.Flush()
}
`;

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/** Windows: one helper process, started on first use and closed after two idle minutes. */
class WindowsBackend {
  constructor() {
    this.child = null;
    this.ready = null;
    this.queue = [];
    this.buffer = '';
    this.idleTimer = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      // The helper is too long for a command line (Windows allows 32,767 characters), so it is run
      // from a file, named after its content so a newer Uma never uses an older one.
      const script = nodePath.join(os.tmpdir(), `uma-input-${crypto.createHash('sha1').update(WINDOWS_HOST).digest('hex').slice(0, 12)}.ps1`);
      if (!fs.existsSync(script)) fs.writeFileSync(script, `﻿${WINDOWS_HOST}`, 'utf8');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let started = false;
      let errors = '';
      child.stderr.on('data', (data) => { errors += data; });
      child.stdout.on('data', (data) => {
        this.buffer += data;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!started) {
            if (line === 'READY') { started = true; resolve(); }
            continue;
          }
          this.queue.shift()?.(line);
        }
      });
      const fail = (message) => {
        // A helper stopped earlier (halt) ends later: it must not clear the one that replaced it.
        if (this.child !== child) return;
        this.child = null;
        this.ready = null;
        for (const answer of this.queue.splice(0)) answer(`ERR ${message}`);
        if (!started) reject(new Error(message));
      };
      child.on('error', (err) => fail(`The input helper could not start: ${err.message}`));
      child.on('exit', () => fail(`The input helper stopped. ${errors.trim().split(/\r?\n/).slice(-2).join(' ')}`.trim()));
    });
    return this.ready;
  }

  async send(line) {
    await this.start();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), 120000);
    this.idleTimer.unref?.();
    const answer = await new Promise((resolve) => {
      this.queue.push(resolve);
      this.child.stdin.write(`${line}\n`);
    });
    if (answer.startsWith('ERR')) throw new Error(answer.slice(4).trim() || 'The action failed.');
    return answer.slice(3).trim();
  }

  async pointer() {
    const [x, y] = (await this.send('pos')).split(' ').map(Number);
    return { x, y };
  }

  move(x, y) { return this.send(`move\t${x}\t${y}`); }
  click(x, y, button, count) { return this.send(`click\t${x}\t${y}\t${button}\t${count}`); }
  scroll(x, y, amount) { return this.send(`scroll\t${x}\t${y}\t${amount}`); }
  drag(x1, y1, x2, y2) { return this.send(`drag\t${x1}\t${y1}\t${x2}\t${y2}`); }
  type(text) { return this.send(`type\t${b64(text)}`); }
  keys(keys) { return this.send(`keys\t${b64(keys)}`); }
  focus(title) { return this.send(`focus\t${b64(title)}`); }
  /** The named items of a window (links, buttons, fields), with their screen rectangles. */
  async items(title = '') {
    const answer = await this.send(`items\t${title ? b64(title) : ''}`);
    return answer.split(' ').filter(Boolean).map((item) => {
      const [kind, x, y, width, height, hidden, ...name] = Buffer.from(item, 'base64').toString('utf8').split('\t');
      return { kind, x: Number(x), y: Number(y), width: Number(width), height: Number(height), hidden: hidden === '1', name: name.join('\t') };
    });
  }

  reveal(name, title = '') { return this.send(`reveal\t${b64(name)}\t${title ? b64(title) : ''}`); }

  async windows() {
    const answer = await this.send('windows');
    return answer.split(' ').filter(Boolean).map((item) => Buffer.from(item, 'base64').toString('utf8'));
  }

  stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.buffer = '';
    for (const answer of this.queue.splice(0)) answer('ERR STOPPED: the user stopped Uma\'s control of the mouse and keyboard.');
    try { child?.stdin.end(); } catch {}
    try { child?.kill(); } catch {}
  }
}

function run(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(String(stdout).trim());
    });
    if (input) child.stdin.end(input);
  });
}

/** macOS: JavaScript for Automation. Uma must be allowed in System Settings → Privacy → Accessibility. */
class MacBackend {
  jxa(code) { return run('osascript', ['-l', 'JavaScript', '-e', code]); }

  async pointer() {
    const out = await this.jxa("ObjC.import('AppKit'); const p = $.NSEvent.mouseLocation; const h = $.NSScreen.mainScreen.frame.size.height; `${Math.round(p.x)} ${Math.round(h - p.y)}`");
    const [x, y] = out.split(' ').map(Number);
    return { x, y };
  }

  mouse(type, x, y, button = 0, clicks = 1) {
    return this.jxa(`ObjC.import('CoreGraphics'); const e = $.CGEventCreateMouseEvent(null, ${type}, $.CGPointMake(${x}, ${y}), ${button}); $.CGEventSetIntegerValueField(e, 1, ${clicks}); $.CGEventPost(0, e); ''`);
  }

  move(x, y) { return this.mouse(5, x, y); }

  async click(x, y, button, count) {
    const [down, up, code] = button === 'right' ? [3, 4, 1] : [1, 2, 0];
    await this.move(x, y);
    for (let n = 1; n <= count; n += 1) {
      await this.mouse(down, x, y, code, n);
      await this.mouse(up, x, y, code, n);
    }
  }

  scroll() { throw new Error('Scrolling with the mouse wheel is not available on macOS here: press "pagedown" or "pageup" with the keyboard tool instead.'); }

  async drag(x1, y1, x2, y2) {
    await this.mouse(1, x1, y1);
    for (let s = 1; s <= 10; s += 1) await this.mouse(6, Math.round(x1 + ((x2 - x1) * s) / 10), Math.round(y1 + ((y2 - y1) * s) / 10));
    await this.mouse(2, x2, y2);
  }

  type(text) { return run('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(String(text))}`]); }

  async keys(keys) {
    const CODES = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, esc: 53, escape: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121 };
    const MODS = { ctrl: 'control down', control: 'control down', shift: 'shift down', alt: 'option down', option: 'option down', cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down' };
    for (const combo of String(keys).split(/\s+/).filter(Boolean)) {
      const parts = combo.toLowerCase().split('+');
      const key = parts.pop();
      const using = parts.map((part) => MODS[part]).filter(Boolean);
      const modifiers = using.length ? ` using {${using.join(', ')}}` : '';
      const action = CODES[key] !== undefined ? `key code ${CODES[key]}` : `keystroke ${JSON.stringify(key)}`;
      await run('osascript', ['-e', `tell application "System Events" to ${action}${modifiers}`]);
    }
  }

  async focus(title) {
    const name = await run('osascript', ['-e', `tell application "System Events"
  set found to first process whose visible is true and (name contains ${JSON.stringify(title)} or (exists (first window whose name contains ${JSON.stringify(title)})))
  set frontmost of found to true
  return name of found
end tell`]);
    return name;
  }

  stop() {}
}

/** Linux: xdotool. */
class LinuxBackend {
  x(args) {
    return run('xdotool', args).catch((err) => {
      if (/ENOENT|not found/i.test(err.message)) throw new Error('Controlling the mouse and keyboard needs xdotool on Linux: install it with "sudo apt install xdotool".');
      throw err;
    });
  }

  async pointer() {
    const out = await this.x(['getmouselocation', '--shell']);
    return { x: Number(/X=(\d+)/.exec(out)?.[1] || 0), y: Number(/Y=(\d+)/.exec(out)?.[1] || 0) };
  }

  move(x, y) { return this.x(['mousemove', String(x), String(y)]); }
  click(x, y, button, count) { return this.x(['mousemove', String(x), String(y), 'click', '--repeat', String(count), button === 'right' ? '3' : button === 'middle' ? '2' : '1']); }
  scroll(x, y, amount) { return this.x(['mousemove', String(x), String(y), 'click', '--repeat', String(Math.abs(amount)), amount > 0 ? '5' : '4']); }
  drag(x1, y1, x2, y2) { return this.x(['mousemove', String(x1), String(y1), 'mousedown', '1', 'mousemove', String(x2), String(y2), 'mouseup', '1']); }
  type(text) { return this.x(['type', '--delay', '12', '--', String(text)]); }
  keys(keys) { return this.x(['key', ...String(keys).split(/\s+/).filter(Boolean).map((combo) => combo.replace(/\bctrl\b/gi, 'ctrl').replace(/\benter\b/gi, 'Return').replace(/\besc(ape)?\b/gi, 'Escape'))]); }
  async focus(title) {
    await this.x(['search', '--onlyvisible', '--name', String(title), 'windowactivate']);
    return title;
  }

  stop() {}
}

const simple = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The item whose name matches `text` best (exact, then starts with, contains, most words), or null. */
function bestItem(items, text) {
  const wanted = simple(text);
  if (!wanted) return null;
  const words = wanted.split(' ');
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const name = simple(item.name);
    if (!name) continue;
    let score = 0;
    if (name === wanted) score = 100;
    else if (name.startsWith(wanted)) score = 85;
    else if (name.includes(wanted)) score = 70;
    else if (wanted.includes(name) && name.length >= 6) score = 55;
    else {
      const have = words.filter((word) => word.length > 1 && name.split(' ').includes(word)).length;
      score = (have / words.length) * 50;
    }
    // A link to a page is a better target than a button with the same words; shorter names are more exact.
    if (score > 0) score += (item.kind === 'Hyperlink' ? 3 : 0) - Math.min(5, name.length / 100);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 40 ? best : null;
}

/**
 * The picture's size and how its pixels map to the screen. `geometry` reports the primary display:
 * { width, height } in the units the system's input uses (physical pixels on Windows and Linux,
 * points on macOS) and the picture the model is shown.
 */
function pictureSize(geometry) {
  const width = Math.min(MODEL_WIDTH, geometry.pixelWidth);
  const height = Math.round((geometry.pixelHeight * width) / geometry.pixelWidth);
  return { width, height };
}

class InputController {
  constructor({ geometry, platform = process.platform, backend = null, onAction = () => {} } = {}) {
    this.geometry = geometry;
    this.backend = backend || (platform === 'win32' ? new WindowsBackend() : platform === 'darwin' ? new MacBackend() : new LinuxBackend());
    this.onAction = onAction;
    this.halted = false;
  }

  /** Pixels of the whole-screen picture -> the screen position the system's input expects. */
  toScreen(x, y) {
    const g = this.geometry();
    const picture = pictureSize(g);
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Give "x" and "y" as numbers: the position in the whole-screen picture from look_at_screen.');
    if (px < 0 || py < 0 || px > picture.width || py > picture.height) {
      throw new Error(`(${px}, ${py}) is outside the screen picture, which is ${picture.width}×${picture.height}. Use a position inside it.`);
    }
    return {
      x: Math.round(g.originX + (px * g.inputWidth) / picture.width),
      y: Math.round(g.originY + (py * g.inputHeight) / picture.height),
    };
  }

  /**
   * The named items of the window in front (or the one whose title has `window`), where a click
   * would land in the whole-screen picture. Chromium builds its accessibility tree on first request,
   * so an almost empty answer is asked again once.
   */
  async findItems(window = '', { all = false } = {}) {
    if (!this.backend.items) throw new Error('Finding things by name works on Windows only here. Use look_at_screen and mouse instead.');
    let items = await this.backend.items(window);
    if (items.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      items = await this.backend.items(window);
    }
    const g = this.geometry();
    const picture = pictureSize(g);
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.name}|${item.x}|${item.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((item) => {
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;
      return {
        ...item,
        screenX: Math.round(cx),
        screenY: Math.round(cy),
        pictureX: Math.round(((cx - g.originX) * picture.width) / g.inputWidth),
        pictureY: Math.round(((cy - g.originY) * picture.height) / g.inputHeight),
      };
    }).filter((item) => (all && item.hidden) || (!item.hidden && item.pictureX >= 0 && item.pictureY >= 0 && item.pictureX <= picture.width && item.pictureY <= picture.height));
  }

  /** Clicks the item whose name best matches `text`; returns what was clicked. */
  async clickItem(text, window = '') {
    await this.guard();
    const items = await this.findItems(window, { all: true });
    let best = bestItem(items, text);
    // Below the fold: scrolled into view first, then found again where it now is.
    if (best?.hidden && this.backend.reveal) {
      await this.backend.reveal(best.name, window).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 600));
      best = (await this.findItems(window)).find((item) => item.name === best.name) || null;
      if (!best) throw new Error(`"${text}" is on the page but could not be brought into view. Press End or scroll down (mouse {"action":"scroll","direction":"down"}), then try again.`);
    }
    if (!best) {
      const names = [...new Set(items.filter((item) => item.kind === 'Hyperlink' || item.kind === 'Button').map((item) => item.name))].slice(0, 25);
      throw new Error(`Nothing named like "${text}" is visible in that window. Visible links and buttons: ${names.map((name) => `"${name.slice(0, 80)}"`).join(', ') || 'none found'}. Use one of these names, scroll, or look at the screen.`);
    }
    await this.backend.click(best.screenX, best.screenY, 'left', 1);
    this.onAction('click', { x: best.pictureX, y: best.pictureY });
    return best;
  }

  /** The titles of the open windows (a browser window's title is its open tab), or [] where unknown. */
  async windows() {
    if (!this.backend.windows) return [];
    return this.backend.windows().catch(() => []);
  }

  /** Stops every action until resume() (the emergency stop, or the user pushing the pointer into the corner). */
  halt() {
    this.halted = true;
    this.backend.stop?.();
  }

  resume() {
    this.halted = false;
  }

  async guard() {
    if (this.halted) throw new Error('STOPPED: the user stopped Uma\'s control of the mouse and keyboard. Do not try again in this reply; tell the user what you were doing.');
    const pointer = await this.backend.pointer().catch(() => null);
    const g = this.geometry();
    if (pointer && pointer.x - g.originX <= CORNER && pointer.y - g.originY <= CORNER) {
      this.halt();
      throw new Error('STOPPED: the user moved the mouse into the top-left corner of the screen to stop Uma. Do not try again in this reply; tell the user what you were doing.');
    }
  }

  /** One action from the model's tools. Returns a short description of what was done. */
  async act(action, args = {}) {
    await this.guard();
    this.onAction(action);
    switch (action) {
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click': {
        const at = this.toScreen(args.x, args.y);
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
        await this.backend.click(at.x, at.y, button, action === 'double_click' ? 2 : 1);
        return `${action.replace('_', ' ')} at (${args.x}, ${args.y})`;
      }
      case 'move': {
        const at = this.toScreen(args.x, args.y);
        await this.backend.move(at.x, at.y);
        return `moved the pointer to (${args.x}, ${args.y})`;
      }
      case 'scroll': {
        const g = this.geometry();
        const picture = pictureSize(g);
        const at = this.toScreen(args.x ?? picture.width / 2, args.y ?? picture.height / 2);
        // "direction" says which way; "amount" alone is positive for down.
        const size = Math.max(1, Math.min(25, Math.abs(Math.round(Number(args.amount) || 5))));
        const amount = /^up$/i.test(String(args.direction || '')) ? -size : /^down$/i.test(String(args.direction || '')) ? size : Math.max(-25, Math.min(25, Math.round(Number(args.amount) || 5)));
        await this.backend.scroll(at.x, at.y, amount);
        return `scrolled ${amount > 0 ? 'down' : 'up'} ${Math.abs(amount)} at (${Math.round(args.x ?? picture.width / 2)}, ${Math.round(args.y ?? picture.height / 2)})`;
      }
      case 'drag': {
        const from = this.toScreen(args.x, args.y);
        const to = this.toScreen(args.to_x, args.to_y);
        await this.backend.drag(from.x, from.y, to.x, to.y);
        return `dragged from (${args.x}, ${args.y}) to (${args.to_x}, ${args.to_y})`;
      }
      case 'type': {
        const text = String(args.text ?? '');
        if (!text) throw new Error('Put the text to type in "text".');
        if (text.length > 2000) throw new Error('Type at most 2000 characters at a time.');
        await this.backend.type(text);
        return `typed ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
      }
      case 'keys': {
        const keys = String(args.keys ?? '').trim();
        if (!keys) throw new Error('Put the keys in "keys", for example "ctrl+l", "enter" or "alt+tab".');
        await this.backend.keys(keys);
        // "h e l l o e n t e r": a real model spelled the Enter key out, and "helloenter" was typed.
        // Each single letter is a key of its own, so the answer says what was typed and how a key is named.
        const parts = keys.split(/\s+/);
        if (parts.length >= 3 && parts.every((part) => part.length === 1)) {
          return `typed "${parts.join('')}", one letter at a time. Every letter given was typed: a key such as Enter or Tab is pressed by its whole name as one word, and text goes in "text", for example {"text":"hello","keys":"enter"}. If letters were typed that were meant as a key, remove them (backspace) and press the key`;
        }
        return `pressed ${keys}`;
      }
      case 'focus': {
        const title = String(args.window ?? '').trim();
        if (!title) throw new Error('Put part of the window title in "window", for example "Brave".');
        const found = await this.backend.focus(title);
        return `brought "${found || title}" to the front`;
      }
      default:
        throw new Error(`Unknown action "${action}".`);
    }
  }

  stop() {
    this.backend.stop?.();
  }
}

module.exports = { InputController, WindowsBackend, pictureSize, bestItem, MODEL_WIDTH };
