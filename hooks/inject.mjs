#!/usr/bin/env node
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
import { fileURLToPath } from 'node:url'


export const PLUGIN_NAME = 'system-prompt'
const KEYS = [ 'enabled', 'prompt', 'prompt_file', 'every_prompt' ]


const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

const toBool = (value, fallback) => {
  if (typeof value === 'boolean')
    return value
  if (typeof value === 'string' && value.length)
    return value === 'true' || value === '1'
  return fallback
}

/** Settings may hold an array of lines, which reads better in hand-edited JSON. */
const toText = value => {
  if (Array.isArray(value))
    return value.map(String).join('\n')
  return typeof value === 'string' ? value : ''
}

/** Options for this plugin from one settings file, under any marketplace. */
export function optionsFromSettings (settings) {
  const configs = settings?.pluginConfigs
  if (!configs || typeof configs !== 'object')
    return {}
  const out = {}
  for (const [ id, entry ] of Object.entries(configs))
    if (id === PLUGIN_NAME || id.startsWith(`${PLUGIN_NAME}@`))
      Object.assign(out, entry?.options ?? {})
  return out
}

export function optionsFromEnv (env) {
  const out = {}
  for (const key of KEYS) {
    const value = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`]
    if (value !== undefined && value !== '')
      out[key] = value
  }
  return out
}

export function resolveConfig ({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const raw = {
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

export function expandPath (path, { cwd, home }) {
  if (path === '~')
    return home
  if (path.startsWith('~/'))
    return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** The text to inject, or '' when there is nothing to say. */
export function buildContent (config, { cwd = process.cwd(), home = homedir(), warn = () => {} } = {}) {
  if (!config.enabled)
    return ''
  const parts = []
  // userConfig fields are single-line inputs, so a literal \n stands for a line break.
  const inline = config.prompt.replace(/\\n/g, '\n').trim()
  if (inline)
    parts.push(inline)
  const files = config.promptFile.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
  for (const file of files) {
    const path = expandPath(file, { cwd, home })
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (text)
        parts.push(text)
    }
    catch (error) {
      warn(`system-prompt: cannot read prompt_file ${path}: ${error.code ?? error.message}`)
    }
  }
  return parts.join('\n\n')
}

/** The hook's stdout for an event, or '' to stay silent. */
export function hookOutput (event, content, config) {
  if (!content)
    return ''
  if (event === 'UserPromptSubmit' && !config.everyPrompt)
    return ''
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit')
    return ''
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName:     event,
      additionalContext: content,
    },
  })
}

const readStdin = async () => {
  if (process.stdin.isTTY)
    return {}
  let data = ''
  for await (const chunk of process.stdin)
    data += chunk
  try {
    return data.trim() ? JSON.parse(data) : {}
  }
  catch {
    return {}
  }
}

async function main () {
  const payload = await readStdin()
  const event   = process.argv[2] || payload.hook_event_name || 'SessionStart'
  const cwd     = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const home    = homedir()
  const config  = resolveConfig({ cwd, home })
  const content = buildContent(config, { cwd, home, warn: msg => process.stderr.write(`${msg}\n`) })
  const out     = hookOutput(event, content, config)
  if (out)
    process.stdout.write(out)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    process.stderr.write(`system-prompt: ${error?.message ?? error}\n`)
    process.exit(0)
  })
