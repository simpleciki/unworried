// LLM_ENABLED: the human's kill switch. "false" (or 0 / off / no) switches every model call off;
// unset or "true" leaves the other walls in charge. Any other value is a loud configuration error.

export type SwitchState = { enabled: true } | { enabled: false; reason: string };

const OFF = new Set(["false", "0", "off", "no"]);
const ON = new Set(["true", "1", "on", "yes"]);

export function killSwitch(env: NodeJS.ProcessEnv = process.env): SwitchState {
  const raw = env.LLM_ENABLED;
  if (raw === undefined || raw.trim() === "") return { enabled: true };
  const v = raw.trim().toLowerCase();
  if (OFF.has(v)) return { enabled: false, reason: `LLM_ENABLED=${raw.trim()}: model calls switched off by the kill switch` };
  if (ON.has(v)) return { enabled: true };
  return { enabled: false, reason: `LLM_ENABLED=${JSON.stringify(raw)} is not a recognised value (use true or false); calls stay off` };
}
