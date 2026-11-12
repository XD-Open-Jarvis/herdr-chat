// A file from the chat's /memory, /config and /hooks, opened to edit: a
// dialog with the file, Save (⌘S) and Close. Props: { file, title, overlay }.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { props, theme, settings, readTextFile, writeTextFile, closeOverlay, exec } from "herdr";

const LANG = { md: "markdown", json: "json", toml: "toml", js: "javascript", sh: "bash", yaml: "yaml", yml: "yaml" };

export function imageFit(viewport, width, height) {
  return Math.min(1, Math.max(1, viewport.width - 24) / Math.max(1, width),
    Math.max(1, viewport.height - 24) / Math.max(1, height));
}

export function imageBounds(viewport, width, height, scale, offset) {
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const limitX = Math.max(0, (w - viewport.width + 24) / 2);
  const limitY = Math.max(0, (h - viewport.height + 24) / 2);
  const x = Math.max(-limitX, Math.min(limitX, offset.x)) || 0;
  const y = Math.max(-limitY, Math.min(limitY, offset.y)) || 0;
  return { width: w, height: h, x, y, left: (viewport.width - w) / 2 + x, top: (viewport.height - h) / 2 + y };
}

export default class ChatFile extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.image) {
      this.viewport = { width: 860, height: 610 };
      this.imageScale = null; // null follows the window's fit size
      this.imageOffset = { x: 0, y: 0 };
      this.imageDrag = null;
      return;
    }
    this.file = p.file;
    this.saved = null; // the text on disk, once read (null: a new file)
    this.status = "Opening…";
    const t = theme();
    this.code = EditorState.new({
      language: LANG[this.file?.split(".").pop()] ?? "markdown", value: "", soft_wrap: true,
      font_family: settings().font_family,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi3, constant: t.ansi6, type: t.ansi4, function: t.ansi4 },
    });
    this.code.on("change", (_e, cx) => { this.status = this.code.value() === (this.saved ?? "") ? "" : "Edited"; cx.notify(); });
    this.handle = cx.focus_handle();
    try { cx.bind_keys([{ keystroke: "cmd-s", action: "chat_file_save", context: "ChatFile" }]); } catch {}
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.file).catch(() => null);
      this.saved = text;
      this.code.set_value(text ?? "");
      this.status = text == null ? "New file" : "";
      cx.notify();
    });
  }

  save(cx) {
    const text = this.code.value();
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", this.file.replace(/\/[^/]*$/, "")]);
        await writeTextFile(this.file, text, this.saved);
        this.saved = text;
        this.status = "Saved";
      } catch (e) {
        this.status = `Couldn't save: ${String(e?.message ?? e)}`;
      }
      cx.notify();
    });
  }

  zoomImage(scale, cx, point = null) {
    const p = props();
    const fit = imageFit(this.viewport, p.imageWidth, p.imageHeight);
    const old = this.imageScale ?? fit;
    const next = Math.max(Math.min(0.1, fit), Math.min(8, scale));
    const bounds = imageBounds(this.viewport, p.imageWidth, p.imageHeight, old, this.imageOffset);
    const x = (point?.x ?? this.viewport.width / 2) - this.viewport.width / 2;
    const y = (point?.y ?? this.viewport.height / 2) - this.viewport.height / 2;
    const moved = imageBounds(this.viewport, p.imageWidth, p.imageHeight, next,
      { x: x - (x - bounds.x) * next / old, y: y - (y - bounds.y) * next / old });
    this.imageScale = next;
    this.imageOffset = { x: moved.x, y: moved.y };
    cx.notify();
  }

  imageView(p, t) {
    const fit = imageFit(this.viewport, p.imageWidth, p.imageHeight);
    const scale = this.imageScale ?? fit;
    const bounds = imageBounds(this.viewport, p.imageWidth, p.imageHeight, scale, this.imageOffset);
    const button = (id, text, tip, action) => div().id(id).flex_none().h(28).px(8).rounded(5)
      .flex().items_center().justify_center().cursor_pointer().text_size(12).tooltip(tip)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
    return v_flex().id("image-window").size_full().bg(t.background).text_color(t.foreground)
      .on_mouse_down_out((_event, cx) => { cx.stop_propagation(); closeOverlay(p.overlay); })
      .child(h_flex().h(40).px(14).gap(4).items_center().flex_none()
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(p.title ?? "Image"))
        .child(button("close-image", "×", "Close", () => closeOverlay(p.overlay))))
      .child(div().id("image-viewport").relative().flex_1().min_h(0).overflow_hidden()
        .tooltip("Scroll to zoom · Drag to pan")
        .on_size_change((size, cx) => {
          if (size.width !== this.viewport.width || size.height !== this.viewport.height) {
            this.viewport = size; cx.notify();
          }
        })
        .on_scroll_wheel((event, cx) => {
          cx.stop_propagation();
          this.zoomImage(scale * Math.exp(Math.max(-0.3, Math.min(0.3, event.delta.y * 0.008))), cx, event.local_position);
        })
        .on_mouse_down("left", (event, cx) => {
          cx.stop_propagation();
          if (event.click_count === 2) {
            this.imageScale = this.imageScale === null ? 1 : null;
            this.imageOffset = { x: 0, y: 0 }; cx.notify(); return;
          }
          this.imageDrag = { start: event.position, x: bounds.x, y: bounds.y };
        })
        .on_mouse_move((event, cx) => {
          if (!this.imageDrag) return;
          const drag = this.imageDrag;
          const moved = imageBounds(this.viewport, p.imageWidth, p.imageHeight, scale,
            { x: drag.x + event.position.x - drag.start.x, y: drag.y + event.position.y - drag.start.y });
          this.imageOffset = { x: moved.x, y: moved.y }; cx.notify();
        })
        .on_mouse_up("left", () => { this.imageDrag = null; })
        .on_hover(on => { if (!on) this.imageDrag = null; })
        .child(div().absolute().left(bounds.left).top(bounds.top).w(bounds.width).h(bounds.height)
          .child(image(p.image).w(bounds.width).h(bounds.height)))
        .child(h_flex().id("image-zoom-controls").absolute().right(12).bottom(12).gap(2).p(4).items_center()
          .rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_md()
          .on_scroll_wheel((_event, cx) => cx.stop_propagation())
        .child(button("image-minus", "−", "Zoom out", cx => this.zoomImage(scale / 1.25, cx)))
        .child(div().w(48).h(28).flex_none().flex().items_center().justify_center().text_size(11.5).text_color(t.muted).child(`${Math.round(scale * 100)}%`))
        .child(button("image-plus", "+", "Zoom in", cx => this.zoomImage(scale * 1.25, cx)))
        .child(button("image-fit", svg("mods/chat-file/fit.svg").size(16), "Fit to window", cx => {
          this.imageScale = null; this.imageOffset = { x: 0, y: 0 }; cx.notify();
        }))
        ));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    if (p.image) return this.imageView(p, t);
    const btn = (id, label, action, primary) => div().id(id).px(12).py(5).rounded(7).cursor_pointer().text_size(12.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click(action).child(label);
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .key_context("ChatFile").track_focus(this.handle)
      .on_action("chat_file_save", (_e, cx) => this.save(cx))
      .child(h_flex().px(14).py(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().child(p.title ?? this.file?.split("/").pop() ?? "File"))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child(this.file ?? "")))
        .when(Boolean(this.status), (el) => el.child(div().text_size(12).text_color(/Couldn't/.test(this.status) ? t.blocked : t.muted).child(this.status)))
        .child(btn("close", "Close", () => closeOverlay(p.overlay)))
        .child(btn("save", "Save", (_e, cx) => this.save(cx), true)))
      .child(div().flex_1().min_h(0).child(Editor.new(this.code).size_full()));
  }
}
