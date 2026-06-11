/**
 * Roblox API dump access — answers "what properties/events does class X have"
 * without touching Studio. Fetched once per process from the public
 * Roblox-Client-Tracker mirror and cached in memory.
 */

const DUMP_URL =
  "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Mini-API-Dump.json";

interface DumpMember {
  MemberType: string;
  Name: string;
  ValueType?: { Name: string };
  Security?: string | { Read?: string; Write?: string };
  Tags?: string[];
}

interface DumpClass {
  Name: string;
  Superclass: string;
  Tags?: string[];
  Members: DumpMember[];
}

export interface ClassInfo {
  className: string;
  superclasses: string[];
  creatable: boolean;
  service: boolean;
  properties: { name: string; type: string; readOnly: boolean; inheritedFrom?: string }[];
  events: { name: string; inheritedFrom?: string }[];
  methods: { name: string; inheritedFrom?: string }[];
  truncated: boolean;
}

let classesByName: Map<string, DumpClass> | null = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (classesByName) return;
  loadPromise ??= (async () => {
    const res = await fetch(DUMP_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`API dump fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { Classes?: DumpClass[] };
    const map = new Map<string, DumpClass>();
    for (const cls of body.Classes ?? []) map.set(cls.Name, cls);
    if (map.size === 0) throw new Error("API dump contained no classes");
    classesByName = map;
  })();
  try {
    await loadPromise;
  } catch (error) {
    loadPromise = null; // allow retry on the next call
    throw error;
  }
}

function isScriptable(member: DumpMember): boolean {
  if (member.Tags?.includes("NotScriptable") || member.Tags?.includes("Deprecated")) return false;
  const security = member.Security;
  const reject = (level?: string) =>
    level !== undefined && level !== "None" && level !== "PluginSecurity";
  if (typeof security === "string") return !reject(security);
  return !reject(security?.Read);
}

const MEMBER_CAP = 200;

/** Look up one class: superclass chain + scriptable members (incl. inherited). */
export async function getClassInfo(className: string): Promise<ClassInfo | null> {
  await ensureLoaded();
  const classes = classesByName as Map<string, DumpClass>;
  const root = classes.get(className);
  if (!root) return null;

  const superclasses: string[] = [];
  const info: ClassInfo = {
    className,
    superclasses,
    creatable: !root.Tags?.includes("NotCreatable"),
    service: root.Tags?.includes("Service") ?? false,
    properties: [],
    events: [],
    methods: [],
    truncated: false,
  };

  let current: DumpClass | undefined = root;
  while (current) {
    const from = current === root ? undefined : current.Name;
    for (const member of current.Members) {
      if (!isScriptable(member)) continue;
      if (info.properties.length + info.events.length + info.methods.length >= MEMBER_CAP) {
        info.truncated = true;
        break;
      }
      if (member.MemberType === "Property") {
        const security = member.Security;
        const writeLevel = typeof security === "object" ? security?.Write : security;
        info.properties.push({
          name: member.Name,
          type: member.ValueType?.Name ?? "unknown",
          readOnly: member.Tags?.includes("ReadOnly") || (writeLevel !== undefined && writeLevel !== "None" && writeLevel !== "PluginSecurity"),
          ...(from ? { inheritedFrom: from } : {}),
        });
      } else if (member.MemberType === "Event") {
        info.events.push({ name: member.Name, ...(from ? { inheritedFrom: from } : {}) });
      } else if (member.MemberType === "Function") {
        info.methods.push({ name: member.Name, ...(from ? { inheritedFrom: from } : {}) });
      }
    }
    const next: DumpClass | undefined = classes.get(current.Superclass);
    if (next) superclasses.push(next.Name);
    current = next;
  }
  return info;
}
