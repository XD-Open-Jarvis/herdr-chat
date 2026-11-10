import { exec } from "herdr";
import { herdr } from "./backstage.js";
import { chatProps, qualifyAddress } from "./identity.js";

// A new pane's ID exists only after pane.split returns. Bind only that exact
// pane, preserving the document and retrying concurrent writes by version.
// This is a creation transaction, not an installer/data-upgrade operation.
export const OWNER_PY = `
import json, os, shutil, subprocess, sys, time
mode, pane, tab, terminal = sys.argv[1:5]
local = lambda value: value.rsplit("/", 1)[-1]
machine = tab.rsplit("/", 1)[0] if "/" in tab else None
for value in (pane, terminal):
    if value and (value.rsplit("/", 1)[0] if "/" in value else None) != machine:
        raise RuntimeError("Pane, tab and terminal must belong to the same machine")
pane, tab, terminal = local(pane), local(tab), local(terminal)
hc = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
params = {"name": "herdr-app", **({"on": machine} if machine else {})}
def rpc(method, args):
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": args}
    result = subprocess.run([hc, "connect"], input=json.dumps(request)+"\\n", text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
    for line in result.stdout.splitlines():
        response = json.loads(line)
        if response.get("id") != 1: continue
        if "error" in response:
            error = RuntimeError(str(response["error"]))
            error.conflict = response["error"].get("data", {}).get("kind") == "conflict"
            raise error
        return response["result"]
    raise RuntimeError("No core reply for " + method)
def nodes(node):
    yield node
    for child in node.get("children", []): yield from nodes(child)
for attempt in range(40):
    saved = rpc("doc.get", params)
    tabs = [t for s in (saved["value"] or {}).get("spaces", []) for t in s.get("tabs", []) if t["id"] == tab]
    if len(tabs) != 1:
        if mode == "find": print("null"); break
        time.sleep(.1); continue
    all_nodes = list(nodes(tabs[0]["root"]))
    if mode == "find":
        matches = []
        for node in all_nodes:
            content = node.get("content", {}); props = content.get("props") or {}
            if (content.get("mod") == "chat" and local(props.get("terminal", "")) == terminal
                and props.get("owner_tab") == tab and props.get("owner_pane") == node["id"]):
                matches.append(node["id"])
        print(json.dumps(matches[-1] if matches else None)); break
    matches = [n for n in all_nodes if n["id"] == pane]
    if len(matches) != 1: time.sleep(.1); continue
    node = matches[0]; content = node.get("content", {}); props = content.get("props") or {}
    if content.get("mod") != "chat" or local(props.get("terminal", "")) != terminal or local(props.get("owner_tab", "")) != tab:
        raise RuntimeError("The created pane no longer has the expected chat binding")
    if props.get("owner_pane") not in (None, pane):
        raise RuntimeError("The created pane has a different owner")
    updated = {**props, "terminal": terminal, "owner_tab": tab, "owner_pane": pane}
    if updated != props:
        content["props"] = updated
        try: rpc("doc.set", {**params, "version": saved["version"], "value": saved["value"]})
        except RuntimeError as error:
            if not getattr(error, "conflict", False): raise
            time.sleep(.1); continue
    print(json.dumps({"pane": pane})); break
else: raise RuntimeError("The new chat pane did not become available; existing panes were left in place")
`;

async function ownerCall(mode, pane, tab, terminal) {
  const result = await exec("python3", ["-c", OWNER_PY, mode, pane ?? "", tab, terminal], { timeout: 30000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not bind the chat pane");
  return JSON.parse(result.stdout.trim());
}

export async function bindOwner(pane, tab, terminal) {
  return ownerCall("bind", pane, tab, terminal);
}

export async function createChat({ pane, tab, terminal, extra = {} }) {
  const created = await herdr("pane.split", { direction: "right", pane, mod: "chat",
    props: { ...extra, ...chatProps(terminal, tab) } });
  await bindOwner(created.pane, tab, terminal);
  return created;
}

export async function openChat({ pane, tab, terminal }) {
  // Read only this known terminal's tab on its known machine. Old/unbound
  // chats remain untouched; reuse a fully owned chat or create a new one.
  const existing = await ownerCall("find", "", tab, terminal);
  if (existing) return { pane: qualifyAddress(existing, tab) };
  return createChat({ pane, tab, terminal });
}
