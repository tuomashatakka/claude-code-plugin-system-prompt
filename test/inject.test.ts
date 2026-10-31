import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKER, renderAgent, ROUTING_GUIDANCE, syncAgents } from '../hooks/agents.ts'
import { buildContent, DEFAULT_MODELS, hookOutput, resolveConfig } from '../hooks/inject.ts'
import type { Config } from '../hooks/inject.ts'


const SCRIPT = join(import.meta.dir, '..', 'hooks', 'inject.ts')

const BASE: Config = { enabled: true, prompt: 'x', promptFile: '', everyPrompt: false, modelRouting: false, agentModels: DEFAULT_MODELS }

const OFF_MODELS = { explore_model: 'off', plan_model: 'off', general_model: 'off' }

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

function runHook (cwd: string, home: string, payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = Bun.spawnSync([ process.execPath, SCRIPT, 'SessionStart' ], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env:   { PATH: process.env.PATH, HOME: home },
    cwd,
  })
  expect(result.exitCode).toBe(0)
  const stdout = result.stdout.toString()
  return stdout ? JSON.parse(stdout) as Record<string, unknown> : undefined
}


describe('resolveConfig', () => {
  test('defaults: enabled, once per session, routing on, cheap subagents', () => {
    const { home, cwd } = sandbox()
    const config        = resolveConfig({ env: {}, cwd, home })
    expect(config).toEqual({ enabled: true, prompt: '', promptFile: '', everyPrompt: false, modelRouting: true, agentModels: DEFAULT_MODELS })
    expect(buildContent(config, { cwd, home })).toBe(ROUTING_GUIDANCE)
  })

  test('subagent models come from user settings and env only', () => {
    const { home, cwd } = sandbox()
    settings(home, { explore_model: 'claude-haiku-5-5', plan_model: '' })
    settings(cwd, { explore_model: 'opus', general_model: 'opus' })
    expect(resolveConfig({ env: {}, cwd, home }).agentModels).toEqual({ 'Explore': 'claude-haiku-5-5', 'Plan': '', 'general-purpose': 'sonnet' })
    expect(resolveConfig({ env: { CLAUDE_PLUGIN_OPTION_GENERAL_MODEL: 'haiku' }, cwd, home }).agentModels['general-purpose']).toBe('haiku')
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
  test('appends routing guidance after the user content', () => {
    expect(buildContent({ ...BASE, modelRouting: true })).toBe(`x\n\n${ROUTING_GUIDANCE}`)
  })

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

  test('a notice alone becomes a systemMessage', () => {
    expect(JSON.parse(hookOutput('SessionStart', '', BASE, 'hello'))).toEqual({ systemMessage: 'hello' })
    expect(hookOutput('UserPromptSubmit', 'x', BASE)).toBe('')
  })
})

describe('syncAgents', () => {
  test('writes overrides once, then leaves them alone', () => {
    const { home } = sandbox()
    const dir      = join(home, '.claude', 'agents')
    expect(syncAgents(dir, DEFAULT_MODELS).map(change => `${change.agent}:${change.action}`))
      .toEqual([ 'Explore:written', 'Plan:written', 'general-purpose:written' ])
    const explore = readFileSync(join(dir, 'Explore.md'), 'utf8')
    expect(explore).toStartWith('---\nname: Explore\n')
    expect(explore).toContain('model: haiku\n')
    expect(explore).toContain('disallowedTools: Write, Edit, NotebookEdit\n')
    expect(explore).toContain(MARKER)
    expect(readFileSync(join(dir, 'general-purpose.md'), 'utf8')).not.toContain('disallowedTools')
    expect(syncAgents(dir, DEFAULT_MODELS)).toEqual([])
  })

  test('rewrites when the model changes and removes when turned off', () => {
    const { home } = sandbox()
    const dir      = join(home, '.claude', 'agents')
    syncAgents(dir, DEFAULT_MODELS)
    syncAgents(dir, { ...DEFAULT_MODELS, Explore: 'claude-haiku-5-5' })
    expect(readFileSync(join(dir, 'Explore.md'), 'utf8')).toBe(renderAgent('Explore', 'claude-haiku-5-5'))
    expect(syncAgents(dir, { ...DEFAULT_MODELS, Explore: 'claude-haiku-5-5', Plan: 'inherit' })).toEqual([{ agent: 'Plan', action: 'removed', path: join(dir, 'Plan.md') }])
    expect(existsSync(join(dir, 'Plan.md'))).toBe(false)
  })

  test("never touches the user's own agent file", () => {
    const { home } = sandbox()
    const dir      = join(home, '.claude', 'agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Explore.md'), '---\nname: Explore\ndescription: mine\n---\nMine.\n')
    const changes = syncAgents(dir, DEFAULT_MODELS)
    expect(changes[0]).toEqual({ agent: 'Explore', action: 'skipped', path: join(dir, 'Explore.md') })
    expect(readFileSync(join(dir, 'Explore.md'), 'utf8')).toContain('Mine.')
    syncAgents(dir, { ...DEFAULT_MODELS, Explore: 'off' })
    expect(existsSync(join(dir, 'Explore.md'))).toBe(true)
  })
})

describe('hook process', () => {
  test('emits JSON for SessionStart and writes the overrides on first run', () => {
    const { home, cwd } = sandbox()
    settings(cwd, { prompt: 'Always answer in Finnish.', model_routing: false })

    const first = runHook(cwd, home, { hook_event_name: 'SessionStart', cwd, source: 'startup' })
    expect(first?.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'Always answer in Finnish.' })
    expect(first?.systemMessage).toContain('next session')
    expect(existsSync(join(home, '.claude', 'agents', 'Explore.md'))).toBe(true)

    const second = runHook(cwd, home, { cwd })
    expect(second?.systemMessage).toBeUndefined()
  })

  test('everything off means no output, no files, exit 0', () => {
    const { home, cwd } = sandbox()
    settings(home, { enabled: false, ...OFF_MODELS })
    expect(runHook(cwd, home, { cwd })).toBeUndefined()
    expect(existsSync(join(home, '.claude', 'agents'))).toBe(false)
  })
})
