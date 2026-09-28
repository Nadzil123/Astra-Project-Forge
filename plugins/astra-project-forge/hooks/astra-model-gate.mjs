#!/usr/bin/env node

const DEFAULT_REQUIRED_MODEL = 'gpt-6-astra';

const normalize = value => String(value ?? '').trim().toLowerCase();
const requiredModel = normalize(process.env.ASTRA_REQUIRED_MODEL) || DEFAULT_REQUIRED_MODEL;
const allowedModels = [...new Set([requiredModel, ...String(process.env.ASTRA_ALLOWED_MODELS || '').split(',').map(normalize).filter(Boolean)])];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function gateStatus(model) {
  const activeModel = normalize(model);
  return {
    activeModel,
    requiredModel,
    eligible: allowedModels.includes(activeModel),
    allowedModels,
  };
}

function contextFor(input) {
  const { activeModel, eligible, allowedModels: acceptedModels } = gateStatus(input.model);
  const shownActive = activeModel || 'unknown';
  const prefix = input?.hook_event_name === 'UserPromptSubmit'
    ? "Astra Project Forge model-gate metadata for the user's message above; do not acknowledge this metadata. The user's message above is the task."
    : 'Astra Project Forge session model-gate metadata; do not acknowledge this metadata unless the user asks about plugin/model status.';

  if (eligible) {
    return `${prefix} Codex reports active model slug \`${shownActive}\`; configured required slug is \`${requiredModel}\`; accepted slugs are ${acceptedModels.map(model => `\`${model}\``).join(', ')}. Gate status: ELIGIBLE. Astra Project Forge may activate automatically when the task benefits from persistent project state, iterative experimentation, verification, uncertainty tracking, or long-horizon continuity in any domain. No keyword, exact prompt, or explicit plugin mention is required. If the task qualifies, apply the Astra Project Forge skill and its MCP tools. Do not activate it for trivial one-shot tasks that gain nothing from persistent state or adaptive iteration.`;
  }

  return `${prefix} Codex reports active model slug \`${shownActive}\`; configured required slug is \`${requiredModel}\`; accepted slugs are ${acceptedModels.map(model => `\`${model}\``).join(', ')}. Gate status: NOT ELIGIBLE. Do not activate Astra Project Forge and do not invoke its MCP tools in this turn. If the user's task would otherwise benefit from Astra Project Forge, ask the user whether they want to switch to \`${requiredModel}\`. Do not claim you switched models yourself; model selection is controlled by the user or host.`;
}

function handle(input) {
  const event = input?.hook_event_name;

  if (event === 'SessionStart') {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: contextFor(input),
      },
    };
  }

  if (event === 'UserPromptSubmit') {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: contextFor(input),
      },
    };
  }

  if (event === 'PreToolUse') {
    const { activeModel, eligible, allowedModels: acceptedModels } = gateStatus(input.model);
    if (eligible) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: acceptedModels.length === 1
          ? `Astra Project Forge requires ${requiredModel}; Codex reports ${activeModel || 'unknown'}. Switch models in Codex before using Astra tools.`
          : `Astra Project Forge requires one of the configured Astra models (${acceptedModels.join(', ')}); Codex reports ${activeModel || 'unknown'}. Switch models in Codex before using Astra tools.`,
      },
    };
  }

  return {};
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = raw.trim() ? JSON.parse(raw) : {};
  write(handle(input));
} catch (error) {
  // Keep stdout valid JSON. Hook process failures are not a security boundary;
  // returning a neutral object avoids corrupting the hook protocol.
  write({});
}
