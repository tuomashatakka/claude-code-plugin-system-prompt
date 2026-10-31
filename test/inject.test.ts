import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildContent, hookOutput, resolveConfig } from '../hooks/inject.ts'
import type { Config } from '../hooks/inject.ts'


const SCRIPT = join(import.meta.dir, '..', 'hooks', 'inject.ts')

const BASE: Config = { enabled: true, prompt: 'x', promptFile: '', everyPrompt: false }

type Sandbox = {
  home: string
  cwd:  string
}


function sandbox (): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'sp-test-'))
  const home = join(root, 'home')
  const cwd  = join(root, 'project')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  return { home, cwd }
}

function settings (dir: string, options: Record<string, unknown>, file = 'settings.json', id = 'system-prompt@system-prompt-extension'): void {
  writeFileSync(join(dir, '.claude', file), JSON.stringify({ pluginConfigs: { [id]: { options }}}))
}

function runHook (cwd: string, home: string, payload: Record<string, unknown>): string {
  const result = Bun.spawnSync([ process.execPath, SCRIPT, 'SessionStart' ], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env:   { PATH: process.env.PATH, HOME: home },
    cwd,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}


describe('resolveConfig', () => {
  test('defaults: enabled, empty, once per session', () => {
    const { home, cwd } = sandbox()
    const config        = resolveConfig({ env: {}, cwd, home })
    expect(config).toEqual({ enabled: true, prompt: '', promptFile: '', everyPrompt: false })
    expect(buildContent(config, { cwd, home })).toBe('')
  })

  test('reads user settings, env overrides user, project overrides env', () => {
    const { home, cwd } = sandbox()
    settings(home, { prompt: 'user', every_prompt: true })
    expect(resolveConfig({ env: {}, cwd, home }).prompt).toBe('user')

    const env = { CLAUDE_PLUGIN_OPTION_PROMPT: 'env' }
    expect(resolveConfig({ env, cwd, home }).prompt).toBe('env')
    expect(resolveConfig({ env, cwd, home }).everyPrompt).toBe(true)

    settings(cwd, { prompt: 'project' })
    expect(resolveConfig({ env, cwd, home }).prompt).toBe('project')

    settings(cwd, { prompt: [ 'a', 'b' ]}, 'settings.local.json', 'system-prompt@x')
    expect(resolveConfig({ env, cwd, home }).prompt).toBe('a\nb')
  })

  test('env booleans arrive as strings', () => {
    const { home, cwd } = sandbox()
    const env           = { CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_PLUGIN_OPTION_EVERY_PROMPT: 'true' }
    const config        = resolveConfig({ env, cwd, home })
    expect(config.enabled).toBe(false)
    expect(config.everyPrompt).toBe(true)
  })
})

describe('buildContent', () => {
  test('combines inline text and files; expands ~ and relative paths', () => {
    const { home, cwd }      = sandbox()
    const warnings: string[] = []
    writeFileSync(join(home, 'global.md'), 'from home\n')
    writeFileSync(join(cwd, 'local.md'), 'from project')

    const content = buildContent(
      { ...BASE, prompt: String.raw `line 1\nline 2`, promptFile: '~/global.md, local.md, missing.md' },
      { cwd, home, warn: message => warnings.push(message) },
    )
    expect(content).toBe('line 1\nline 2\n\nfrom home\n\nfrom project')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/missing\.md/)
  })

  test('disabled injects nothing', () => {
    expect(buildContent({ ...BASE, enabled: false, everyPrompt: true })).toBe('')
  })
})

describe('hookOutput', () => {
  test('UserPromptSubmit stays silent unless every_prompt', () => {
    expect(hookOutput('UserPromptSubmit', 'x', BASE)).toBe('')
    expect(JSON.parse(hookOutput('UserPromptSubmit', 'x', { ...BASE, everyPrompt: true }))).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' },
    })
    expect(JSON.parse(hookOutput('SessionStart', 'x', BASE)).hookSpecificOutput.additionalContext).toBe('x')
  })

  test('unknown events stay silent', () => {
    expect(hookOutput('Stop', 'x', BASE)).toBe('')
  })
})

describe('hook process', () => {
  test('emits JSON for SessionStart', () => {
    const { home, cwd } = sandbox()
    settings(cwd, { prompt: 'Always answer in Finnish.' })
    expect(JSON.parse(runHook(cwd, home, { hook_event_name: 'SessionStart', cwd, source: 'startup' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Always answer in Finnish.' },
    })
  })

  test('nothing configured means no output and exit 0', () => {
    const { home, cwd } = sandbox()
    expect(runHook(cwd, home, { cwd })).toBe('')
  })
})
