// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "chat-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// Closing an agent's terminal that has a chat beside it (the close button)
// asks first: it would end the agent.
// The question is this mod opened as a dialog, with props { ask, chat }.
// Splitting a zoomed chat keeps its agent's terminal hidden: it moves out of
// the tab (backstage.js), so only the new terminal joins the chat.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, props, run, theme, home, terminals, openOverlay, closeOverlay } from "herdr";
import { herdr, away, hide, show } from "./backstage.js";


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
    // Plain shells split beside them close like any other pane.
    const isAgent = (x) => x.terminal && (x.program?.agent || x.status);
    const chat = isAgent(p) ? inTab.find((x) => x.mod === "chat") : null;
    const agent = p.mod === "chat" ? this.agentOf(p) : null;
    if (!chat && !agent) return run("pane.close", { pane: p.pane });
    const question = chat ? { ask: p.pane, chat: chat.pane } : { ask: agent.pane ?? null, term: agent.terminal, chat: p.pane, from: "chat" };
    openOverlay({ mod: "chat-pane", kind: "dialog", width: 420, height: 170, props: question });
  }

  // A chat pane's agent: its terminal's pane in the tab, or the terminal it hid away.
  agentOf(chat) {
    const here = panes().find((x) => x.tab === chat.tab && x.terminal && (x.program?.agent || x.status));
    if (here) return here;
    const tab = chat.tab.split("/").pop();
    const term = terminals().find((x) => x.state === "live" && x.labels?.["chat.tab"] === tab && away(x));
    return term ? { terminal: term.address, pane: panes().find((x) => x.terminal === term.address)?.pane } : null;
  }

  // Splits beside a zoomed chat without showing its agent: the agent's terminal
  // leaves the tab first, then the chat unzooms beside the new terminal.
  split(p, direction, cx) {
    const agent = p.mod === "chat" && p.zoomed ? panes().find((x) => x.tab === p.tab && x.terminal && (x.program?.agent || x.status)) : null;
    if (!agent) return run("pane.split", { direction, pane: p.pane });
    cx.spawn(async () => {
      try {
        await hide(terminals().find((x) => x.address === agent.terminal), p.tab);
        await herdr("pane.zoom", { pane: p.pane });
      } catch {}
      run("pane.split", { direction, pane: p.pane });
    });
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
        .child(this.splitButton(t, p, "right"))
        .child(this.splitButton(t, p, "down"))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.closeButton(t, p)));
  }

  splitButton(t, p, direction) {
    return div().id(`ph-${direction[0]}-${p.pane}`).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.split(p, direction, cx); })
      .child(svg(`mods/chat-pane/split-${direction}.svg`).size(14));
  }

  closeButton(t, p) {
    return div().id(`ph-x-${p.pane}`).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.closePane(p); })
      .child(svg("mods/chat-pane/close.svg").size(14));
  }

  answer(what, cx) {
    const { overlay, ask, term, chat } = props();
    closeOverlay(overlay);
    const chatPane = panes().find((x) => x.pane === chat);
    const agentTerm = () => terminals().find((x) => x.address === (term ?? panes().find((x) => x.pane === ask)?.terminal));
    // Its terminal hid away from the chat (Hide terminal): it's in a tab of its own.
    const hidden = away(agentTerm());
    if (what === "end") {
      // Ends the agent and closes its chat with it: the whole tab when that's all it holds.
      if (hidden) { run("terminal.kill", { terminal: agentTerm().address }); run("pane.close", { pane: chat }); return; }
      const tab = panes().find((x) => x.pane === ask)?.tab;
      if (tab && !panes().some((x) => x.tab === tab && x.pane !== ask && x.pane !== chat)) run("tab.close", { id: tab, confirmed: true });
      else { run("pane.close", { pane: ask }); run("pane.close", { pane: chat }); }
    }
    // Only the agent's terminal goes; other panes beside the chat stay.
    else if (what === "hide" && chatPane) cx.spawn(async () => { try { await hide(agentTerm(), chatPane.tab); } catch {} });
    // The chat goes and its terminal takes its place, back from its own tab if it hid.
    else if (what === "keep") {
      if (!hidden) return run("pane.close", { pane: chat });
      cx.spawn(async () => { try { await show(agentTerm()); } catch {} run("pane.close", { pane: chat }); });
    }
  }

  question(t) {
    const p = props();
    const button = (id, label, primary, what) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.answer(what, cx)).child(label);
    return v_flex().id("ask").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.answer("end", cx);
        else if (e.key === "escape") this.answer("cancel", cx);
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
