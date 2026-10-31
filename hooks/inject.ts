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
 * The hook never fails the session: any error is written to stderr and the
 * hook exits 0 with no output.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'


export const PLUGIN_NAME = 'system-prompt'

const KEYS   = [ 'enabled', 'prompt', 'prompt_file', 'every_prompt' ] as const
const EVENTS = [ 'SessionStart', 'UserPromptSubmit' ] as const

type OptionKey = typeof KEYS[number]

export type HookEvent = typeof EVENTS[number]

/** Raw option values: booleans and strings from settings, strings from env, arrays of lines from hand-edited JSON. */
export type RawOptions = Partial<Record<OptionKey, unknown>>

export type Config = {
  enabled:     boolean
  prompt:      string
  promptFile:  string
  everyPrompt: boolean
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

export function resolveConfig ({ env = process.env, cwd = process.cwd(), home = homedir() }: ResolveOptions = {}): Config {
  const claudeHome      = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const raw: RawOptions = {
    ...optionsFromSettings(readJson(join(claudeHome, 'settings.json'))),
    ...optionsFromEnv(env),
    ...optionsFromSettings(readJson(join(cwd, '.claude', 'settings.json'))),
    ...optionsFromSettings(readJson(join(cwd, '.claude', 'settings.local.json'))),
  }
  return {
    enabled:     toBool(raw.enabled, true),
    prompt:      toText(raw.prompt),
    promptFile:  toText(raw.prompt_file),
    everyPrompt: toBool(raw.every_prompt, false),
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
  return parts.join('\n\n')
}

/** The hook's stdout for an event, or '' to stay silent. */
export function hookOutput (event: string, content: string, config: Config): string {
  if (!content || !isHookEvent(event))
    return ''
  if (event === 'UserPromptSubmit' && !config.everyPrompt)
    return ''
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName:     event,
      additionalContext: content,
    },
  })
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
  const out     = hookOutput(event, content, config)
  if (out)
    process.stdout.write(out)
}


if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(`system-prompt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 0
  })
