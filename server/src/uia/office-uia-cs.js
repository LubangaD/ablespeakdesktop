/**
 * C# half of the Office reader: the custom UI Automation properties Excel,
 * Word and PowerPoint publish for assistive technology
 * (https://learn.microsoft.com/en-us/office/uia/).
 *
 * These are *custom* properties, identified by GUID, so a client has to
 * register each one with IUIAutomationRegistrar before it can read it. The
 * managed System.Windows.Automation wrapper used by the screen model has no
 * registrar, so this half talks to UIA3 (COM) directly, declaring only the
 * few interface methods it calls. The order of the methods in each interface
 * is the order of the COM vtable and must not change: the unused ones are
 * placeholders that hold their slot.
 *
 * Output is ASCII-only JSON (other characters as \uXXXX), so it survives the
 * console code page. Keep this source free of backticks and dollar signs: it
 * is embedded in a JS template and a PowerShell here-string.
 */
export const OFFICE_UIA_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public enum OfficeUiaType { Int = 1, Bool = 2, String = 3, Double = 4 }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct OfficeUiaPropertyInfo {
    public Guid guid;
    [MarshalAs(UnmanagedType.LPWStr)] public string programmaticName;
    public OfficeUiaType type;
}

[ComImport, Guid("8609c4ec-4a1a-4d88-a357-5a66e060e1cf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOfficeUiaRegistrar {
    void RegisterProperty(ref OfficeUiaPropertyInfo property, out int propertyId);
}

[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOfficeUiaElement {
    void SetFocus();
    void GetRuntimeId(out IntPtr runtimeId);
    void FindFirst(int scope, IntPtr condition, out IOfficeUiaElement found);
    void FindAll(int scope, IntPtr condition, out IntPtr found);
    void FindFirstBuildCache(int scope, IntPtr condition, IntPtr cacheRequest, out IOfficeUiaElement found);
    void FindAllBuildCache(int scope, IntPtr condition, IntPtr cacheRequest, out IntPtr found);
    void BuildUpdatedCache(IntPtr cacheRequest, out IOfficeUiaElement updated);
    void GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
}

[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOfficeUiaAutomation {
    void CompareElements(IOfficeUiaElement a, IOfficeUiaElement b, out bool same);
    void CompareRuntimeIds(IntPtr a, IntPtr b, out bool same);
    void GetRootElement(out IOfficeUiaElement root);
    void ElementFromHandle(IntPtr hwnd, out IOfficeUiaElement element);
    void ElementFromPoint(System.Drawing.Point pt, out IOfficeUiaElement element);
    void GetFocusedElement(out IOfficeUiaElement element);
    void GetRootElementBuildCache(IntPtr cacheRequest, out IOfficeUiaElement root);
    void ElementFromHandleBuildCache(IntPtr hwnd, IntPtr cacheRequest, out IOfficeUiaElement element);
    void ElementFromPointBuildCache(System.Drawing.Point pt, IntPtr cacheRequest, out IOfficeUiaElement element);
    void GetFocusedElementBuildCache(IntPtr cacheRequest, out IOfficeUiaElement element);
    void CreateTreeWalker(IntPtr condition, out IntPtr walker);
    void GetControlViewWalker(out IntPtr walker);
    void GetContentViewWalker(out IntPtr walker);
    void GetRawViewWalker(out IntPtr walker);
    void GetRawViewCondition(out IntPtr condition);
    void GetControlViewCondition(out IntPtr condition);
    void GetContentViewCondition(out IntPtr condition);
    void CreateCacheRequest(out IntPtr cacheRequest);
    void CreateTrueCondition(out IntPtr condition);
    void CreateFalseCondition(out IntPtr condition);
    void CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, out IntPtr condition);
}

public static class OfficeUia {
    static readonly Guid CLSID_CUIAutomation = new Guid("ff48dba4-60ef-4201-aa87-54103eef594e");
    static readonly Guid CLSID_CUIAutomationRegistrar = new Guid("6e29fabf-9977-42d1-8d0e-ca7e61ad87e6");

    // Registering the same GUID twice returns the same id, but the call costs
    // a round trip, so each one is kept for the life of the worker.
    static readonly Dictionary<string, int> Ids = new Dictionary<string, int>();
    static IOfficeUiaAutomation automation;

    static IOfficeUiaAutomation Automation() {
        if (automation == null) {
            automation = (IOfficeUiaAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_CUIAutomation));
        }
        return automation;
    }

    static int Register(string name, string guid, OfficeUiaType type) {
        int id;
        if (Ids.TryGetValue(guid, out id)) return id;
        var registrar = (IOfficeUiaRegistrar)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_CUIAutomationRegistrar));
        var info = new OfficeUiaPropertyInfo { guid = new Guid(guid), programmaticName = name, type = type };
        registrar.RegisterProperty(ref info, out id);
        Ids[guid] = id;
        return id;
    }

    const int UIA_ProcessIdPropertyId = 30002;
    const int UIA_NamePropertyId = 30005;
    const int UIA_ControlTypePropertyId = 30003;
    const int UIA_AutomationIdPropertyId = 30011;
    const int TreeScope_Descendants = 4;

    /**
     * Read the named Office properties from the element with keyboard focus
     * (the cell being edited, the word an error sits on). Each spec is
     * "name|guid|type", type as in OfficeUiaType. Returns a JSON object with
     * the element's "pid" and "name" and each property, leaving out anything
     * still at its default, or {"error": "focus elsewhere"} when keyboard
     * focus is not in the window hwnd belongs to.
     */
    public static string ReadFocused(long hwnd, string[] specs) {
        IOfficeUiaElement element;
        try {
            Automation().GetFocusedElement(out element);
        } catch (Exception e) {
            return Error("no focused element: " + e.Message);
        }
        if (element == null) return Error("no focused element");
        // Focus in another app (AbleSpeak's own overlay, say) is not the cell
        // the student means.
        object pid = null;
        try { element.GetCurrentPropertyValue(UIA_ProcessIdPropertyId, out pid); } catch (Exception) {}
        uint windowPid;
        GetWindowThreadProcessId(new IntPtr(hwnd), out windowPid);
        if (!(pid is int) || (uint)(int)pid != windowPid) return Error("focus elsewhere");
        return Read(element, specs);
    }

    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /**
     * Read the named properties from the first element under a window whose
     * AutomationId matches: Word keeps its proofing properties on one node of
     * the Editor pane rather than on the focused word.
     */
    public static string ReadNode(long hwnd, string automationId, string[] specs) {
        IntPtr condition = IntPtr.Zero;
        try {
            IOfficeUiaElement root;
            Automation().ElementFromHandle(new IntPtr(hwnd), out root);
            if (root == null) return Error("no window");
            Automation().CreatePropertyCondition(UIA_AutomationIdPropertyId, automationId, out condition);
            IOfficeUiaElement found;
            root.FindFirst(TreeScope_Descendants, condition, out found);
            if (found == null) return Error("not found");
            return Read(found, specs);
        } catch (Exception e) {
            return Error("read failed: " + e.Message);
        } finally {
            if (condition != IntPtr.Zero) Marshal.Release(condition);
        }
    }

    static string Read(IOfficeUiaElement element, string[] specs) {
        var json = new StringBuilder("{");
        object pid = null, name = null, controlType = null;
        try { element.GetCurrentPropertyValue(UIA_ProcessIdPropertyId, out pid); } catch (Exception) {}
        try { element.GetCurrentPropertyValue(UIA_NamePropertyId, out name); } catch (Exception) {}
        try { element.GetCurrentPropertyValue(UIA_ControlTypePropertyId, out controlType); } catch (Exception) {}
        json.Append(Quote("pid")).Append(':').Append(pid is int ? Literal(pid) : "0");
        json.Append(',').Append(Quote("name")).Append(':').Append(Quote(name as string ?? ""));
        json.Append(',').Append(Quote("controlType")).Append(':').Append(controlType is int ? Literal(controlType) : "0");
        bool first = false;
        foreach (string spec in specs) {
            string[] parts = spec.Split('|');
            if (parts.Length != 3) continue;
            object value;
            try {
                int id = Register(parts[0], parts[1], (OfficeUiaType)int.Parse(parts[2], CultureInfo.InvariantCulture));
                element.GetCurrentPropertyValue(id, out value);
            } catch (Exception) {
                continue; // an older Office build without this property
            }
            if (IsDefault(value)) continue;
            if (!first) json.Append(',');
            first = false;
            json.Append(Quote(parts[0])).Append(':').Append(Literal(value));
        }
        return json.Append('}').ToString();
    }

    static bool IsDefault(object value) {
        if (value == null) return true;
        if (value is string) return ((string)value).Length == 0;
        if (value is bool) return !((bool)value);
        // Numbers are kept even at 0: a table position of 0 is a real place
        // (the header row, the first column).
        return false;
    }

    static string Literal(object value) {
        if (value is bool) return ((bool)value) ? "true" : "false";
        if (value is int) return ((int)value).ToString(CultureInfo.InvariantCulture);
        if (value is double) return ((double)value).ToString(CultureInfo.InvariantCulture);
        return Quote(value.ToString());
    }

    static string Error(string message) {
        return "{" + Quote("error") + ":" + Quote(message) + "}";
    }

    /** ASCII-only JSON string, so the console code page cannot spoil it. */
    static string Quote(string text) {
        var sb = new StringBuilder("\"");
        foreach (char c in text) {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
`;
