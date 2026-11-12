import { div } from "gpui-kit";
import { h_flex, TextView } from "gpui-base";
import { diffBlocks } from "./diff.js";

const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const alpha = (color, opacity) => /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)
  ? color.slice(0, 7) + opacity : color;

export function renderDiffBlocks(file, id, t, font) {
  return diffBlocks(file).map((block, index) => {
    const changed = block.kind === "added" || block.kind === "removed";
    const ink = block.kind === "added" ? t.ansi2 : block.kind === "removed" ? t.ansi1
      : block.kind === "hunk" ? t.ansi6 : t.muted;
    const background = changed ? alpha(ink, "20") : block.kind === "hunk" ? alpha(t.ansi6, "12") : null;
    const gutter = changed ? alpha(ink, "35") : alpha(t.chrome, "70");
    const numberText = block.numbers.map(number => number || " ").join("\n");
    const codeText = block.code.map(line => line || " ").join("\n");
    return h_flex().id(`${id}-row-${index}`).w_full().min_w(0).items_start()
      .when(Boolean(background), element => element.bg(background))
      .child(div().w(50).flex_none().px(7).py(2).bg(gutter).text_color(ink)
        .child(TextView.html(`${id}-number-${index}`, `<pre>${escape(numberText)}</pre>`)
          .text_right().text_size(12).line_height("19px").when(Boolean(font), element => element.font_family(font))))
      .child(div().flex_1().min_w(0).px(10).py(2).overflow_hidden()
        .child(TextView.html(`${id}-code-${index}`, `<pre>${escape(codeText)}</pre>`)
          .selectable(true).text_size(12).line_height("19px")
          .text_color(block.kind === "hunk" ? t.ansi6 : t.foreground)
          .when(Boolean(font), element => element.font_family(font))));
  });
}
