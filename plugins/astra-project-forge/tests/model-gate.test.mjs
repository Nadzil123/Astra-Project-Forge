import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const pluginRoot = path.resolve('.');
const hookScript = path.join(pluginRoot, 'hooks', 'astra-model-gate.mjs');
const hookConfig = path.join(pluginRoot, 'hooks', 'hooks.json');

function runHook(input, env = {}) {
  const run = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(run.status, 0, run.stderr || 'hook exited non-zero');
  assert.ok(run.stdout.trim(), 'hook must emit JSON');
  return JSON.parse(run.stdout);
}

test('bundles a model gate hook and lifecycle config', () => {
  assert.equal(existsSync(hookScript), true, 'missing hooks/astra-model-gate.mjs');
  assert.equal(existsSync(hookConfig), true, 'missing hooks/hooks.json');
  const config = JSON.parse(readFileSync(hookConfig, 'utf8'));
  assert.ok(config.hooks?.UserPromptSubmit?.length, 'UserPromptSubmit hook missing');
  assert.ok(config.hooks?.PreToolUse?.length, 'PreToolUse hook missing');
  assert.match(config.hooks.PreToolUse[0].matcher || '', /astra.*project.*forge/i);
});

test('session-start context reports model eligibility without pretending there is a user prompt', () => {
  const output = runHook({
    session_id: 's0', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'SessionStart', model: 'gpt-6-astra',
    permission_mode: 'default', source: 'startup'
  });
  const context = output.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /eligible/i);
  assert.doesNotMatch(context, /user's message above/i);
});

test('marks GPT-6 Astra turns eligible without requiring trigger keywords', () => {
  const output = runHook({
    session_id: 's1', turn_id: 't1', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'UserPromptSubmit', model: 'gpt-6-astra',
    permission_mode: 'default', prompt: 'Please continue the project from yesterday.'
  });
  const context = output.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /eligible/i);
  assert.match(context, /no keyword/i);
  assert.match(context, /user's message above is the task/i);
});

test('fails closed on a non-Astra model and asks for a user-controlled switch', () => {
  const output = runHook({
    session_id: 's2', turn_id: 't2', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'UserPromptSubmit', model: 'gpt-5.6-sol',
    permission_mode: 'default', prompt: 'Help me with a complex project.'
  });
  const context = output.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /not eligible/i);
  assert.match(context, /ask the user/i);
  assert.match(context, /switch/i);
  assert.match(context, /do not claim.*switch/i);
});

test('does not block Astra MCP tool calls on the required model and denies other models', () => {
  const allowed = runHook({
    session_id: 's3', turn_id: 't3', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'PreToolUse', model: 'gpt-6-astra', permission_mode: 'default',
    tool_name: 'mcp__astra-project-forge__adaptive_get_state', tool_input: {}, tool_use_id: 'u1'
  });
  assert.notEqual(allowed.hookSpecificOutput?.permissionDecision, 'deny');

  const denied = runHook({
    session_id: 's4', turn_id: 't4', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'PreToolUse', model: 'gpt-5.6-sol', permission_mode: 'default',
    tool_name: 'mcp__astra-project-forge__adaptive_get_state', tool_input: {}, tool_use_id: 'u2'
  });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput?.permissionDecisionReason || '', /requires gpt-6-astra/i);
});

test('supports an explicit future model slug override', () => {
  const output = runHook({
    session_id: 's5', turn_id: 't5', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'PreToolUse', model: 'future-astra-slug', permission_mode: 'default',
    tool_name: 'mcp__astra-project-forge__adaptive_get_state', tool_input: {}, tool_use_id: 'u3'
  }, { ASTRA_REQUIRED_MODEL: 'future-astra-slug' });
  assert.notEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
});

test('skill declares universal semantic activation behind the model gate', () => {
  const skill = readFileSync(path.join(pluginRoot, 'skills', 'astra-project-forge', 'SKILL.md'), 'utf8');
  assert.match(skill, /model gate/i);
  assert.match(skill, /no keyword/i);
  assert.match(skill, /any domain/i);
  assert.match(skill, /do not activate/i);
});

test('supports multiple explicitly allowed Astra model slugs', () => {
  const output = runHook({
    session_id: 's6', turn_id: 't6', transcript_path: null, cwd: pluginRoot,
    hook_event_name: 'PreToolUse', model: 'gpt-6-astra-alt', permission_mode: 'default',
    tool_name: 'mcp__astra-project-forge__forge_route', tool_input: {}, tool_use_id: 'u4'
  }, { ASTRA_REQUIRED_MODEL: 'gpt-6-astra', ASTRA_ALLOWED_MODELS: 'gpt-6-astra,gpt-6-astra-alt' });
  assert.notEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
});
