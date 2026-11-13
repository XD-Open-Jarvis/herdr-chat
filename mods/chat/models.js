// Models and effort levels for Claude Code and Codex: what can be picked,
// how to start an agent with them, and how to switch a running one.
import { exec, hc } from "herdr";
import { CODEX_TITLE_CONFIG } from "./title.js";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5", alias: "opus" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", alias: "sonnet" },
  { id: "claude-fable-5-1", name: "Fable 5.1", alias: "fable" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", alias: "haiku" },
];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const cat = async (path, on) =>
  (await exec("sh", ["-c", 'cat "$HOME/$1" 2>/dev/null', "sh", path], { on })).stdout;

// { models: [{ id, name, efforts }], model, effort }: the choices and the defaults.
export async function catalog(kind, on) {
  if (kind === "claude") {
    let s = {};
    try { s = JSON.parse(await cat(".claude/settings.json", on)); } catch {}
    const custom = typeof s.model === "string" && s.model.trim() ? s.model.trim() : null;
    const known = CLAUDE_MODELS.find((m) => m.alias === custom || m.id === custom);
    const models = (known || !custom ? CLAUDE_MODELS : [{ id: custom, name: custom }, ...CLAUDE_MODELS]).map((m) => ({ ...m, efforts: CLAUDE_EFFORTS }));
    const model = known?.id ?? custom ?? CLAUDE_MODELS[0].id;
    const effort = s.modelSettings?.[model]?.effortLevel ?? s.effortLevel ?? "medium";
    return { models, model, effort };
  }
  let c = {};
  try { c = JSON.parse(await cat(".codex/models_cache.json", on)); } catch {}
  const models = (c.models ?? []).filter((m) => m.visibility === "list").map((m) => ({
    id: m.slug, name: m.display_name ?? m.slug,
    efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
  }));
  const toml = await cat(".codex/config.toml", on);
  const top = toml.split(/^\s*\[/m)[0] ?? "";
  return {
    models,
    model: /^model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? models[0]?.id,
    effort: /^model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? "medium",
  };
}

export const modelName = (models, id) =>
  models?.find((m) => m.id === id)?.name ?? CLAUDE_MODELS.find((m) => m.id === id || id?.startsWith(m.id))?.name ?? id ?? "";

export function launchArgv(kind, model, effort, task) {
  const argv = kind === "codex"
    ? ["codex", "-c", CODEX_TITLE_CONFIG, ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])]
    : ["claude", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  if (task) argv.push(task);
  return argv;
}

// Codex switches for the session only. Claude's /model and /effort also save
// themselves as the default for new sessions, so its settings file is put back.
export async function switchModel(term, kind, model, effort, on, sleep) {
  const send = async command => {
    const result = await hc(["send", term, command]);
    if (result.code !== 0) throw new Error(result.stderr?.trim() || "Could not apply model settings");
    return result;
  };
  if (kind === "codex") {
    if (!model) throw new Error("Choose a model before changing reasoning effort");
    return send(`/model ${model}${effort ? ` --reasoning=${effort}` : ""}`);
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const f = '"$HOME/.claude/settings.json"';
  const bak = `"$HOME/.claude/settings.json.chat-bak-${stamp}"`;
  const probe = await exec("sh", ["-c", `if [ -f ${f} ]; then cp ${f} ${bak} && echo had; elif [ ! -e ${f} ]; then echo missing; fi`], { on });
  const state = (probe?.stdout ?? "").trim();
  try {
    if (model) { await send(`/model ${model}`); await sleep(1200); }
    if (effort) { await send(`/effort ${effort}`); await sleep(1200); }
  } finally {
    if (state === "had") await exec("sh", ["-c", `[ -f ${bak} ] && mv -f ${bak} ${f}`], { on });
    else if (state === "missing") await exec("sh", ["-c", `rm -f ${f} ${bak}`], { on });
  }
}
