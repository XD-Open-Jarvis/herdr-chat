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
    const model = CLAUDE_MODELS.find((m) => m.alias === s.model || m.id === s.model)?.id ?? CLAUDE_MODELS[0].id;
    const effort = s.modelSettings?.[model]?.effortLevel ?? s.effortLevel ?? "medium";
    return { models: CLAUDE_MODELS.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })), model, effort };
  }
  let c = {};
  try { c = JSON.parse(await cat(".codex/models_cache.json", on)); } catch {}
  const models = (c.models ?? []).filter((m) => m.visibility === "list").map((m) => ({
    id: m.slug, name: m.display_name ?? m.slug,
    efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
  }));
  const toml = await cat(".codex/config.toml", on);
  return {
    models,
    model: /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? models[0]?.id,
    effort: /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? "medium",
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
  if (kind === "codex") return hc(["send", term, `/model ${model}${effort ? ` --reasoning=${effort}` : ""}`]);
  const f = '"$HOME/.claude/settings.json"';
  await exec("sh", ["-c", `cp ${f} ${f}.chat-bak`], { on });
  try {
    if (model) { await hc(["send", term, `/model ${model}`]); await sleep(1200); }
    if (effort) { await hc(["send", term, `/effort ${effort}`]); await sleep(1200); }
  } finally {
    await exec("sh", ["-c", `cp ${f}.chat-bak ${f} && rm -f ${f}.chat-bak`], { on });
  }
}
