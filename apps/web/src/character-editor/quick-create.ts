import type { EditorPresentationPort } from "./workspace.js";
/** Compact presentation of the same controls and adapter; never creates a draft. */
export function mountQuickCharacterCreate(host: HTMLElement, options: {
  context: "world-draft" | "campaign-supporting"; port: EditorPresentationPort;
  fields: HTMLElement; aiTools?: HTMLElement; onContinue(): void;
}): { dispose(): void } {
  const document = host.ownerDocument, root = document.createElement("section");
  root.className = "character-quick-create";
  const heading = document.createElement("h2"); heading.textContent = "Add character";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const nodes = [options.fields, ...(options.aiTools ? [options.aiTools] : [])];
  const markers = nodes.map(node => { const marker = document.createComment("quick-character-fields"); node.before(marker); root.append(node); return marker; });
  const actions = document.createElement("footer"); actions.className = "character-quick-actions";
  let busy = false, disposed = false, error = "";
  const blocked = () => { const state = options.port.snapshot(); return busy || disposed || state.busy || state.locked || state.readOnly; };
  const button = (text: string, action: () => void, primary = false) => {
    const node = document.createElement("button"); node.type = "button"; node.className = `button ${primary ? "primary" : "secondary"}`; node.textContent = text; node.addEventListener("click", action); actions.append(node); return node;
  };
  button("Cancel", () => { if (busy || options.port.snapshot().busy) return; options.port.flush(); void options.port.requestClose(); });
  button("Continue in detailed editor", () => { if (blocked()) return; options.port.flush(); options.onContinue(); });
  const commit = button(options.context === "world-draft" ? "Add to world draft" : "Create campaign character", () => void (async () => {
    if (blocked()) return;
    options.port.flush(); busy = true; error = ""; commit.disabled = true;
    try { await options.port.commit(); } catch { error = "Save failed; your changes are kept"; }
    finally { busy = false; if (!disposed) { commit.disabled = false; status.textContent = error || options.port.snapshot().status; } }
  })(), true);
  const cancel = (event: Event) => { event.preventDefault(); if (busy || options.port.snapshot().busy) return; options.port.flush(); void options.port.requestClose(); };
  const dialog = host.closest("dialog"); dialog?.addEventListener("cancel", cancel);
  root.prepend(heading); root.append(status, actions); host.append(root);
  dialog?.classList.add("character-quick-dialog");
  return { dispose() { if (disposed) return; disposed = true; dialog?.removeEventListener("cancel", cancel); dialog?.classList.remove("character-quick-dialog"); nodes.forEach((node, index) => markers[index]!.replaceWith(node)); root.remove(); } };
}
