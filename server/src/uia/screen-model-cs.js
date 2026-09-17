/**
 * C# half of the screen model (Stage 2), compiled once inside the persistent
 * PowerShell worker. Reading a window through PowerShell loops asks Windows
 * for each property of each control separately; this asks once, with a
 * CacheRequest, and writes the JSON itself.
 *
 * Output is ASCII-only JSON (other characters as \uXXXX), so it survives the
 * console code page. Keep this source free of backticks and dollar signs: it
 * is embedded in a JS template and a PowerShell here-string.
 */
export const SCREEN_MODEL_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class ScreenModel {
    static readonly AutomationProperty[] Available = {
        AutomationElement.IsInvokePatternAvailableProperty,
        AutomationElement.IsValuePatternAvailableProperty,
        AutomationElement.IsTogglePatternAvailableProperty,
        AutomationElement.IsExpandCollapsePatternAvailableProperty,
        AutomationElement.IsSelectionItemPatternAvailableProperty,
        AutomationElement.IsScrollPatternAvailableProperty,
        AutomationElement.IsScrollItemPatternAvailableProperty,
        AutomationElement.IsTextPatternAvailableProperty,
        AutomationElement.IsRangeValuePatternAvailableProperty
    };
    static readonly string[] ActionNames = {
        "invoke", "set_value", "toggle", "expand_collapse", "select", "scroll", "scroll_into_view", "read_text", "set_range"
    };

    // Everything visible in one round trip: the whole control-view subtree,
    // skipping off-screen branches, as data only (no live handles, which is
    // what makes it fast). Actions find their control again by runtime id.
    static CacheRequest Request() {
        CacheRequest request = new CacheRequest();
        request.TreeScope = TreeScope.Subtree;
        request.TreeFilter = new AndCondition(
            Automation.ControlViewCondition,
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        request.AutomationElementMode = AutomationElementMode.None;
        request.Add(AutomationElement.NameProperty);
        request.Add(AutomationElement.ControlTypeProperty);
        request.Add(AutomationElement.AutomationIdProperty);
        request.Add(AutomationElement.BoundingRectangleProperty);
        request.Add(AutomationElement.IsEnabledProperty);
        request.Add(AutomationElement.HasKeyboardFocusProperty);
        request.Add(AutomationElement.RuntimeIdProperty);
        foreach (AutomationProperty property in Available) request.Add(property);
        request.Add(ValuePattern.Pattern);
        request.Add(ValuePattern.ValueProperty);
        request.Add(TogglePattern.Pattern);
        request.Add(TogglePattern.ToggleStateProperty);
        request.Add(ExpandCollapsePattern.Pattern);
        request.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        request.Add(SelectionItemPattern.Pattern);
        request.Add(SelectionItemPattern.IsSelectedProperty);
        return request;
    }

    static object Cached(AutomationElement element, AutomationProperty property) {
        try {
            object value = element.GetCachedPropertyValue(property, true);
            return value == AutomationElement.NotSupported ? null : value;
        } catch { return null; }
    }

    static void Str(StringBuilder json, string value) {
        json.Append('"');
        foreach (char c in value ?? "") {
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c < 32 || c > 126) json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        json.Append('"');
    }

    static string Error(string code, string message) {
        StringBuilder json = new StringBuilder("{\"error\":");
        Str(json, code);
        json.Append(",\"message\":");
        Str(json, message);
        return json.Append('}').ToString();
    }

    static void PushChildren(Stack<AutomationElement> pending, AutomationElement parent) {
        AutomationElementCollection children;
        try { children = parent.CachedChildren; } catch { return; }
        for (int i = children.Count - 1; i >= 0; i--) pending.Push(children[i]);
    }

    static string RefOf(int[] runtimeId) {
        if (runtimeId == null) return "";
        string[] parts = new string[runtimeId.Length];
        for (int i = 0; i < runtimeId.Length; i++) parts[i] = runtimeId[i].ToString();
        return string.Join(".", parts);
    }

    // The window's controls, front to back in reading order, as JSON.
    public static string Snapshot(long hwnd, int maxElements) {
        Stopwatch timer = Stopwatch.StartNew();
        if (IsIconic(new IntPtr(hwnd))) return Error("MINIMIZED", "The window is minimized");
        AutomationElement root;
        string windowName;
        System.Windows.Rect windowRect;
        try {
            root = AutomationElement.FromHandle(new IntPtr(hwnd));
            windowName = root.Current.Name;
            windowRect = root.Current.BoundingRectangle;
        } catch (Exception e) {
            return Error("NO_WINDOW", e.Message);
        }

        AutomationElement tree;
        try {
            CacheRequest request = Request();
            using (request.Activate()) {
                tree = root.GetUpdatedCache(request);
            }
        } catch (Exception e) {
            return Error("READ_FAILED", e.Message);
        }
        long readMs = timer.ElapsedMilliseconds;

        // Flatten in reading order, leaving out the window itself.
        List<AutomationElement> found = new List<AutomationElement>();
        Stack<AutomationElement> pending = new Stack<AutomationElement>();
        PushChildren(pending, tree);
        while (pending.Count > 0) {
            AutomationElement next = pending.Pop();
            found.Add(next);
            PushChildren(pending, next);
        }

        List<string> actionable = new List<string>();
        List<string> readable = new List<string>();
        foreach (AutomationElement element in found) {
            string name = Cached(element, AutomationElement.NameProperty) as string ?? "";
            ControlType type = Cached(element, AutomationElement.ControlTypeProperty) as ControlType;
            object rectValue = Cached(element, AutomationElement.BoundingRectangleProperty);
            if (!(rectValue is System.Windows.Rect)) continue;
            System.Windows.Rect rect = (System.Windows.Rect)rectValue;
            if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) continue;

            List<string> actions = new List<string>();
            for (int i = 0; i < Available.Length; i++) {
                object available = Cached(element, Available[i]);
                if (available is bool && (bool)available) actions.Add(ActionNames[i]);
            }
            if (name.Length == 0 && actions.Count == 0) continue;

            StringBuilder json = new StringBuilder("{\"ref\":");
            Str(json, RefOf(Cached(element, AutomationElement.RuntimeIdProperty) as int[]));
            json.Append(",\"type\":");
            Str(json, type == null ? "Custom" : type.ProgrammaticName.Replace("ControlType.", ""));
            json.Append(",\"name\":");
            Str(json, name.Length > 120 ? name.Substring(0, 120) : name);
            string automationId = Cached(element, AutomationElement.AutomationIdProperty) as string;
            if (!string.IsNullOrEmpty(automationId)) { json.Append(",\"automationId\":"); Str(json, automationId); }
            json.Append(",\"rect\":[").Append((int)rect.X).Append(',').Append((int)rect.Y).Append(',')
                .Append((int)rect.Width).Append(',').Append((int)rect.Height).Append(']');
            object enabled = Cached(element, AutomationElement.IsEnabledProperty);
            json.Append(",\"enabled\":").Append(enabled is bool && !(bool)enabled ? "false" : "true");
            object focused = Cached(element, AutomationElement.HasKeyboardFocusProperty);
            if (focused is bool && (bool)focused) json.Append(",\"focused\":true");
            json.Append(",\"actions\":[");
            for (int i = 0; i < actions.Count; i++) { if (i > 0) json.Append(','); Str(json, actions[i]); }
            json.Append(']');

            object value = Cached(element, ValuePattern.ValueProperty);
            if (value is string && ((string)value).Length > 0) {
                string text = (string)value;
                json.Append(",\"value\":");
                Str(json, text.Length > 200 ? text.Substring(0, 200) : text);
            }
            object toggle = Cached(element, TogglePattern.ToggleStateProperty);
            if (toggle is ToggleState) { json.Append(",\"toggled\":"); Str(json, toggle.ToString().ToLower()); }
            object expand = Cached(element, ExpandCollapsePattern.ExpandCollapseStateProperty);
            if (expand is ExpandCollapseState && (ExpandCollapseState)expand != ExpandCollapseState.LeafNode) {
                json.Append(",\"expanded\":"); Str(json, expand.ToString().ToLower());
            }
            object selected = Cached(element, SelectionItemPattern.IsSelectedProperty);
            if (selected is bool && (bool)selected) json.Append(",\"selected\":true");
            json.Append('}');

            if (actions.Count > 0) actionable.Add(json.ToString()); else readable.Add(json.ToString());
        }

        // Controls first; plain text only while there is room.
        List<string> kept = new List<string>();
        foreach (string item in actionable) { if (kept.Count >= maxElements) break; kept.Add(item); }
        foreach (string item in readable) { if (kept.Count >= maxElements) break; kept.Add(item); }

        StringBuilder result = new StringBuilder("{\"window\":{\"name\":");
        Str(result, windowName);
        result.Append(",\"hwnd\":").Append(hwnd)
            .Append(",\"rect\":[").Append((int)windowRect.X).Append(',').Append((int)windowRect.Y).Append(',')
            .Append((int)windowRect.Width).Append(',').Append((int)windowRect.Height).Append("]}");
        result.Append(",\"total\":").Append(actionable.Count + readable.Count);
        result.Append(",\"actionable\":").Append(actionable.Count);
        result.Append(",\"truncated\":").Append(actionable.Count + readable.Count > kept.Count ? "true" : "false");
        result.Append(",\"readMs\":").Append(readMs);
        result.Append(",\"ms\":").Append(timer.ElapsedMilliseconds);
        result.Append(",\"elements\":[").Append(string.Join(",", kept.ToArray())).Append("]}");
        return result.ToString();
    }

    static AutomationElement FindByRef(AutomationElement root, string reference) {
        string[] parts = (reference ?? "").Split('.');
        int[] runtimeId = new int[parts.Length];
        for (int i = 0; i < parts.Length; i++) {
            if (!int.TryParse(parts[i], out runtimeId[i])) return null;
        }
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.RuntimeIdProperty, runtimeId));
    }

    // Patterns that can block until a dialog they open is closed run on
    // their own thread, so the worker never hangs.
    static bool RunBriefly(ThreadStart work, out string failure) {
        string error = null;
        Thread thread = new Thread(delegate () {
            try { work(); } catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
        });
        thread.IsBackground = true;
        thread.Start();
        bool finished = thread.Join(3000);
        failure = error;
        return finished;
    }

    // Act on one control through its own accessibility pattern.
    public static string Act(long hwnd, string reference, string action, string value) {
        AutomationElement root;
        AutomationElement element;
        try {
            root = AutomationElement.FromHandle(new IntPtr(hwnd));
            element = FindByRef(root, reference);
        } catch (Exception e) {
            return Error("NO_WINDOW", e.Message);
        }
        if (element == null) return Error("NOT_FOUND", "That control is no longer on screen");

        string name = "";
        try { name = element.Current.Name; } catch { }
        string failure = null;
        bool finished = true;
        try {
            switch (action) {
                case "invoke": {
                    InvokePattern pattern = (InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern);
                    finished = RunBriefly(delegate () { pattern.Invoke(); }, out failure);
                    break;
                }
                case "toggle": {
                    TogglePattern pattern = (TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern);
                    finished = RunBriefly(delegate () { pattern.Toggle(); }, out failure);
                    break;
                }
                case "select": {
                    SelectionItemPattern pattern = (SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern);
                    finished = RunBriefly(delegate () { pattern.Select(); }, out failure);
                    break;
                }
                case "expand":
                case "collapse": {
                    ExpandCollapsePattern pattern = (ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                    bool expand = action == "expand";
                    finished = RunBriefly(delegate () { if (expand) pattern.Expand(); else pattern.Collapse(); }, out failure);
                    break;
                }
                case "set_value": {
                    ValuePattern pattern = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                    if (pattern.Current.IsReadOnly) return Error("READ_ONLY", "That field cannot be changed");
                    pattern.SetValue(value ?? "");
                    break;
                }
                case "scroll_into_view": {
                    ScrollItemPattern pattern = (ScrollItemPattern)element.GetCurrentPattern(ScrollItemPattern.Pattern);
                    pattern.ScrollIntoView();
                    break;
                }
                case "scroll_up":
                case "scroll_down":
                case "scroll_left":
                case "scroll_right": {
                    ScrollPattern pattern = (ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern);
                    ScrollAmount back = ScrollAmount.LargeDecrement;
                    ScrollAmount forward = ScrollAmount.LargeIncrement;
                    if (action == "scroll_up") pattern.ScrollVertical(back);
                    else if (action == "scroll_down") pattern.ScrollVertical(forward);
                    else if (action == "scroll_left") pattern.ScrollHorizontal(back);
                    else pattern.ScrollHorizontal(forward);
                    break;
                }
                case "read_text": {
                    TextPattern pattern = (TextPattern)element.GetCurrentPattern(TextPattern.Pattern);
                    string text = pattern.DocumentRange.GetText(4000);
                    StringBuilder json = new StringBuilder("{\"ok\":true,\"action\":\"read_text\",\"name\":");
                    Str(json, name);
                    json.Append(",\"text\":");
                    Str(json, text);
                    return json.Append('}').ToString();
                }
                case "focus":
                    element.SetFocus();
                    break;
                default:
                    return Error("UNKNOWN_ACTION", action);
            }
        } catch (InvalidOperationException) {
            return Error("NOT_SUPPORTED", "That control does not support " + action);
        } catch (ElementNotAvailableException) {
            return Error("NOT_FOUND", "That control is no longer on screen");
        } catch (Exception e) {
            return Error("FAILED", e.Message);
        }
        if (failure != null) return Error("FAILED", failure);

        StringBuilder done = new StringBuilder("{\"ok\":true,\"action\":");
        Str(done, action);
        done.Append(",\"name\":");
        Str(done, name);
        done.Append(",\"finished\":").Append(finished ? "true" : "false");
        return done.Append('}').ToString();
    }

    public static long Foreground() {
        return GetForegroundWindow().ToInt64();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);
}
`;
