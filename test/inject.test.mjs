import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContent, hookOutput, resolveConfig } from '../hooks/inject.mjs'


const SCRIPT = fileURLToPath(new URL('../hooks/inject.mjs', import.meta.url))

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-test-'))
  const home = join(root, 'home')
  const cwd  = join(root, 'project')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  return { root, home, cwd }
}

const settings = (dir, options) =>
  writeFileSync(join(dir, '.claude', 'settings.json'),
    JSON.stringify({ pluginConfigs: { 'system-prompt@system-prompt-extension': { options } } }))


test('defaults: enabled, empty, once per session', () => {
  const { home, cwd } = sandbox()
  const config = resolveConfig({ env: {}, cwd, home })
  assert.deepEqual(config, { enabled: true, prompt: '', promptFile: '', everyPrompt: false })
  assert.equal(buildContent(config, { cwd, home }), '')
})

test('reads user settings, env overrides user, project overrides env', () => {
  const { home, cwd } = sandbox()
  settings(home, { prompt: 'user', every_prompt: true })
  assert.equal(resolveConfig({ env: {}, cwd, home }).prompt, 'user')

  const env = { CLAUDE_PLUGIN_OPTION_PROMPT: 'env' }
  assert.equal(resolveConfig({ env, cwd, home }).prompt, 'env')
  assert.equal(resolveConfig({ env, cwd, home }).everyPrompt, true)

  settings(cwd, { prompt: 'project' })
  assert.equal(resolveConfig({ env, cwd, home }).prompt, 'project')

  writeFileSync(join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ pluginConfigs: { 'system-prompt@x': { options: { prompt: [ 'a', 'b' ] } } } }))
  assert.equal(resolveConfig({ env, cwd, home }).prompt, 'a\nb')
})

test('env booleans arrive as strings', () => {
  const { home, cwd } = sandbox()
  const config = resolveConfig({ env: { CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_PLUGIN_OPTION_EVERY_PROMPT: 'true' }, cwd, home })
  assert.equal(config.enabled, false)
  assert.equal(config.everyPrompt, true)
})

test('combines inline text and files; expands ~ and relative paths', () => {
  const { home, cwd } = sandbox()
  writeFileSync(join(home, 'global.md'), 'from home\n')
  writeFileSync(join(cwd, 'local.md'), 'from project')
  const warnings = []
  const content = buildContent(
    { enabled: true, prompt: 'line 1\\nline 2', promptFile: '~/global.md, local.md, missing.md', everyPrompt: false },
    { cwd, home, warn: msg => warnings.push(msg) },
  )
  assert.equal(content, 'line 1\nline 2\n\nfrom home\n\nfrom project')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing\.md/)
})

test('disabled injects nothing', () => {
  assert.equal(buildContent({ enabled: false, prompt: 'x', promptFile: '', everyPrompt: true }), '')
})

test('UserPromptSubmit stays silent unless every_prompt', () => {
  const base = { enabled: true, prompt: 'x', promptFile: '', everyPrompt: false }
  assert.equal(hookOutput('UserPromptSubmit', 'x', base), '')
  const out = JSON.parse(hookOutput('UserPromptSubmit', 'x', { ...base, everyPrompt: true }))
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' } })
  assert.equal(JSON.parse(hookOutput('SessionStart', 'x', base)).hookSpecificOutput.additionalContext, 'x')
})

test('end to end: hook process emits JSON for SessionStart', () => {
  const { home, cwd } = sandbox()
  settings(cwd, { prompt: 'Always answer in Finnish.' })
  const stdout = execFileSync('node', [ SCRIPT, 'SessionStart' ], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd, source: 'startup' }),
    env:   { PATH: process.env.PATH, HOME: home },
  }).toString()
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Always answer in Finnish.' },
  })
})

test('end to end: nothing configured means no output and exit 0', () => {
  const { home, cwd } = sandbox()
  const stdout = execFileSync('node', [ SCRIPT, 'SessionStart' ], {
    input: JSON.stringify({ cwd }),
    env:   { PATH: process.env.PATH, HOME: home },
  }).toString()
  assert.equal(stdout, '')
})
