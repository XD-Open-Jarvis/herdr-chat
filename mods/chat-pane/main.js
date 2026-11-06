// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "chat-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// Closing an agent's terminal that has a chat beside it (the close button)
// asks first: it would end the agent.
// The question is this mod opened as a dialog, with props { ask, chat }.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, props, run, theme, home, openOverlay, closeOverlay } from "herdr";


function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    if (props()?.overlay) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
  }

  // Closes the pane, or asks first when that would end the agent behind a chat.
  // (Not `close`: Herdr calls a View's close() itself whenever a copy goes away.)
  closePane(p) {
    const inTab = panes().filter((x) => x.tab === p.tab && x.pane !== p.pane);
    // The agent's terminal, or its chat: either one closing ends the pair.
    const chat = p.terminal ? inTab.find((x) => x.mod === "chat") : null;
    const agent = p.mod === "chat" ? inTab.find((x) => x.terminal && x.program?.agent) ?? inTab.find((x) => x.terminal) : null;
    if (!chat && !agent) return run("pane.close", { pane: p.pane });
    const question = chat ? { ask: p.pane, chat: chat.pane } : { ask: agent.pane, chat: p.pane, from: "chat" };
    openOverlay({ mod: "chat-pane", kind: "dialog", width: 420, height: 170, props: question });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/chat-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    if (props()?.overlay) return this.question(t);
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.closeButton(t, p)));
  }

  closeButton(t, p) {
    return div().id(`ph-x-${p.pane}`).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.closePane(p); })
      .child(svg("mods/chat-pane/close.svg").size(14));
  }

  answer(what) {
    const { overlay, ask, chat } = props();
    closeOverlay(overlay);
    if (what === "end") {
      // Ends the agent and closes its chat with it: the whole tab when that's all it holds.
      const tab = panes().find((x) => x.pane === ask)?.tab;
      if (tab && !panes().some((x) => x.tab === tab && x.pane !== ask && x.pane !== chat)) run("tab.close", { id: tab, confirmed: true });
      else { run("pane.close", { pane: ask }); run("pane.close", { pane: chat }); }
    }
    else if (what === "hide" && !panes().find((x) => x.pane === chat)?.zoomed) run("pane.zoom", { pane: chat });
    else if (what === "keep") run("pane.close", { pane: chat });
  }

  question(t) {
    const p = props();
    const button = (id, label, primary, what) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(() => this.answer(what)).child(label);
    return v_flex().id("ask").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.answer("end");
        else if (e.key === "escape") this.answer("cancel");
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("End this agent?"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).text_color(t.muted)
        .child(p.from === "chat"
          ? "Closing this chat ends the agent and closes its terminal. Keep running closes only the chat."
          : "Closing this terminal ends the agent and closes its chat. Hide terminal keeps it running."))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("cancel", "Cancel", false, "cancel"))
        .child(p.from === "chat" ? button("keep", "Keep running", false, "keep") : button("hide", "Hide terminal", false, "hide"))
        .child(button("end", "End agent", true, "end")));
  }
}
