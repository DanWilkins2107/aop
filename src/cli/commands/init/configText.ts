import { stringify } from "yaml";
import { ABOUT, type Settings } from "./settings.js";

const yamlScalar = (value: string | number) => stringify(value, { lineWidth: 0 }).trimEnd();

/** Wraps lines for config comments. */
function comment(text: string): string {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > 90 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  return [...lines, line].join("\n");
}

/** The config.yaml `aop init` writes. */
export function configText(settings: Settings): string {
  const outOfSandbox =
    settings.out_of_sandbox_command === undefined
      ? "# out_of_sandbox_command: claude"
      : `out_of_sandbox_command: ${yamlScalar(settings.out_of_sandbox_command)}`;
  return `# AOP machine config, shared by all projects. Written by \`aop init\`.
# Relative paths start from this file's folder. \`~\` is your home folder.

# Required. AOP appends \`-p\` and sends the prompt on stdin.
${comment(ABOUT.agent_session_command)}
agent_session_command: ${yamlScalar(settings.agent_session_command)}

# Optional.
${comment(ABOUT.out_of_sandbox_command)}
${outOfSandbox}

${comment(ABOUT.open_from)}
open_from: ${yamlScalar(settings.open_from)}

${comment(ABOUT.agent_timeout_minutes)}
agent_timeout_minutes: ${settings.agent_timeout_minutes}

${comment(ABOUT.stages)} It can live anywhere.
stages: ${yamlScalar(settings.stages)}

${comment(ABOUT.improvement_stages)} Leave it out to turn improvements off.
improvement_stages: ./improvement_stages.yaml

${comment(ABOUT.improvements_path)} Never config.yaml or a stages file.
improvements_path: ${yamlScalar(settings.improvements_path)}
`;
}
