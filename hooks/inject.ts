#!/usr/bin/env bun
/**
 * Appends user-defined content to Claude's context.
 *
 * Run as a SessionStart hook (always) and a UserPromptSubmit hook (only when
 * `every_prompt` is on). The content comes from the plugin's userConfig, which
 * Claude Code stores under `pluginConfigs["system-prompt@<marketplace>"].options`
 * in settings.json and exports to hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
 *
 * Resolution, later wins:
 *   1. ~/.claude/settings.json            (user)
 *   2. CLAUDE_PLUGIN_OPTION_* env vars    (what Claude Code resolved)
 *   3. <project>/.claude/settings.json    (project, shared)
 *   4. <project>/.claude/settings.local.json (project, personal)
 *
 * The subagent models (`explore_model`, `plan_model`, `general_model`) are
 * read from the user-level sources only (1 and 2), because the overrides
 * they produce live in ~/.claude/agents and apply to every project.
 *
 * The hook never fails the session: any error is written to stderr and the
 * hook exits 0 with no output.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { describeChanges, ROUTING_GUIDANCE, syncAgents } from './agents.ts'
import type { AgentModels } from './agents.ts'


export const PLUGIN_NAME = 'system-prompt'

/** Defaults for the built-in subagent overrides. */
export const DEFAULT_MODELS: AgentModels = {
  'Explore':         'haiku',
  'Plan':            'sonnet',
  'general-purpose': 'sonnet',
}

const KEYS   = [ 'enabled', 'prompt', 'prompt_file', 'every_prompt', 'model_routing', 'explore_model', 'plan_model', 'general_model' ] as const
const EVENTS = [ 'SessionStart', 'UserPromptSubmit' ] as const

type OptionKey = typeof KEYS[number]

export type HookEvent = typeof EVENTS[number]

/** Raw option values: booleans and strings from settings, strings from env, arrays of lines from hand-edited JSON. */
export type RawOptions = Partial<Record<OptionKey, unknown>>

export type Config = {
  enabled:      boolean
  prompt:       string
  promptFile:   string
  everyPrompt:  boolean
  modelRouting: boolean
  agentModels:  AgentModels
}

export type Paths = {
  cwd:  string
  home: string
}

export type BuildOptions = Partial<Paths> & {
  warn?: (message: string) => void
}

export type ResolveOptions = Partial<Paths> & {
  env?: Record<string, string | undefined>
}

type PluginConfigEntry = {
  options?: RawOptions
}

type Settings = {
  pluginConfigs?: Record<string, PluginConfigEntry | undefined>
}

type HookPayload = {
  hook_event_name?: string
  cwd?:             string
}


function readJson (path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

function toBool (value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean')
    return value
  if (typeof value === 'string' && value.length > 0)
    return value === 'true' || value === '1'
  return fallback
}

/** A model option: unset falls back to the default, an empty string means off. */
function toModel (value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Settings may hold an array of lines, which reads better in hand-edited JSON. */
function toText (value: unknown): string {
  if (Array.isArray(value))
    return value.map(String).join('\n')
  return typeof value === 'string' ? value : ''
}

function isHookEvent (event: string): event is HookEvent {
  return (EVENTS as readonly string[]).includes(event)
}

/** Options for this plugin from one settings file, under any marketplace. */
export function optionsFromSettings (settings: unknown): RawOptions {
  const configs = (settings as Settings | undefined)?.pluginConfigs
  if (!configs || typeof configs !== 'object')
    return {}

  const out: RawOptions = {}
  for (const [ id, entry ] of Object.entries(configs))
    if (id === PLUGIN_NAME || id.startsWith(`${PLUGIN_NAME}@`))
      Object.assign(out, entry?.options ?? {})
  return out
}

export function optionsFromEnv (env: Record<string, string | undefined>): RawOptions {
  const out: RawOptions = {}
  for (const key of KEYS) {
    const value = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`]
    if (value !== undefined && value !== '')
      out[key] = value
  }
  return out
}

export function claudeHomeDir (env: Record<string, string | undefined>, home: string): string {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

export function resolveConfig ({ env = process.env, cwd = process.cwd(), home = homedir() }: ResolveOptions = {}): Config {
  const user: RawOptions = {
    ...optionsFromSettings(readJson(join(claudeHomeDir(env, home), 'settings.json'))),
    ...optionsFromEnv(env),
  }
  const raw: RawOptions = {
    ...user,
    ...optionsFromSettings(readJson(join(cwd, '.claude', 'settings.json'))),
    ...optionsFromSettings(readJson(join(cwd, '.claude', 'settings.local.json'))),
  }
  return {
    enabled:      toBool(raw.enabled, true),
    prompt:       toText(raw.prompt),
    promptFile:   toText(raw.prompt_file),
    everyPrompt:  toBool(raw.every_prompt, false),
    modelRouting: toBool(raw.model_routing, true),
    agentModels:  {
      'Explore':         toModel(user.explore_model, DEFAULT_MODELS.Explore),
      'Plan':            toModel(user.plan_model, DEFAULT_MODELS.Plan),
      'general-purpose': toModel(user.general_model, DEFAULT_MODELS['general-purpose']),
    },
  }
}

export function expandPath (path: string, { cwd, home }: Paths): string {
  if (path === '~')
    return home
  if (path.startsWith('~/'))
    return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** The text to inject, or '' when there is nothing to say. */
export function buildContent (config: Config, { cwd = process.cwd(), home = homedir(), warn = () => {} }: BuildOptions = {}): string {
  if (!config.enabled)
    return ''

  const parts: string[] = []
  // userConfig fields are single-line inputs, so a literal \n stands for a line break.
  const inline = config.prompt.replaceAll(String.raw `\n`, '\n').trim()
  if (inline)
    parts.push(inline)

  const files = config.promptFile.split(/[\n,]/).map(file => file.trim())
    .filter(Boolean)
  for (const file of files) {
    const path = expandPath(file, { cwd, home })
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (text)
        parts.push(text)
    }
    catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message
      warn(`system-prompt: cannot read prompt_file ${path}: ${reason}`)
    }
  }
  if (config.modelRouting)
    parts.push(ROUTING_GUIDANCE)
  return parts.join('\n\n')
}

/** The hook's stdout for an event, or '' to stay silent. `notice` is shown to the user, not the model. */
export function hookOutput (event: string, content: string, config: Config, notice = ''): string {
  if (!isHookEvent(event))
    return ''

  const inject = Boolean(content) && (event === 'SessionStart' || config.everyPrompt)
  if (!inject && !notice)
    return ''
  return JSON.stringify({
    ...notice ? { systemMessage: notice } : {},
    ...inject
      ? { hookSpecificOutput: { hookEventName: event, additionalContext: content }}
      : {},
  })
}

/** Keeps ~/.claude/agents in line with the configured subagent models. Returns a notice for the user. */
function syncSubagents (config: Config, home: string): string {
  try {
    const dir = join(claudeHomeDir(process.env, home), 'agents')
    return describeChanges(syncAgents(dir, config.agentModels))
  }
  catch (error) {
    return `system-prompt: could not update subagent overrides: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function readPayload (): Promise<HookPayload> {
  if (process.stdin.isTTY)
    return {}
  try {
    const data = await Bun.stdin.text()
    return data.trim() ? JSON.parse(data) as HookPayload : {}
  }
  catch {
    return {}
  }
}

async function main (): Promise<void> {
  const payload = await readPayload()
  const event   = Bun.argv[2] || payload.hook_event_name || 'SessionStart'
  const cwd     = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const home    = homedir()
  const config  = resolveConfig({ cwd, home })
  const content = buildContent(config, { cwd, home, warn: message => console.error(message) })
  const notice  = event === 'SessionStart' ? syncSubagents(config, home) : ''
  const out     = hookOutput(event, content, config, notice)
  if (out)
    process.stdout.write(out)
}


if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(`system-prompt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 0
  })
