/**
 * Overrides for Claude Code's built-in subagents, so they run on a cheaper
 * model than the main conversation.
 *
 * A plugin's own `agents/` are namespaced (`system-prompt:Explore`) and never
 * shadow a built-in; only a user or project agent with the same bare name
 * does. So the SessionStart hook writes these definitions into the user's
 * agents directory (`~/.claude/agents`). Claude Code reads that directory when
 * a session starts, so a change made by the hook applies from the next session.
 *
 * Every file written here carries MARKER. A file without it belongs to the
 * user and is never overwritten or removed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


export const MARKER = 'managedBy: system-prompt-plugin'

/** Option values that mean "leave the built-in alone". */
const OFF = new Set([ '', 'off', 'none', 'false', 'inherit', 'default', 'builtin' ])

const READ_ONLY = [ 'Write', 'Edit', 'NotebookEdit' ]

const TEMPLATES: Record<AgentName, AgentTemplate> = {
  'Explore': {
    description:     'Read-only scout for questions about a codebase: locates files, symbols and usages, and explains how existing code works. Say how deep to go: "quick" for one targeted lookup, "medium" for a normal survey, "very thorough" when the answer may be spread across many places.',
    disallowedTools: READ_ONLY,
    omitClaudeMd:    true,
    body:            `Your job is to look through a codebase and report back what is there. Nothing you do may change it.

Ground rules:
- No creating, editing, moving or deleting files. Shell use is limited to inspection (ls, find, git log, git show, git diff, cat); never run anything that writes to disk, installs a package or makes a commit.
- Glob finds files by name, Grep finds text inside them, Read opens a file whose path you already know. Issue independent lookups together rather than one after another.
- Scale the effort to the depth you were asked for: stop at the first solid answer for "quick"; for "very thorough", try several directories and naming styles before you conclude something is absent.

Whatever you write last is all the requester sees. Lead with the answer, point to code as path:line, quote only what backs the answer up, and state clearly anything you looked for but did not find.`,
  },
  'Plan': {
    description:     'Read-only planner for a change that is about to be made: studies the code it will touch and returns ordered steps, the key files, and the trade-offs between viable approaches.',
    disallowedTools: READ_ONLY,
    omitClaudeMd:    true,
    body:            `You turn a requirement into an implementation plan. You study the code and write the plan; someone else carries it out.

Nothing you do may change the project: no creating, editing, moving or deleting files, and shell use only for inspection.

Approach:
1. Restate the goal and the constraints you were given.
2. Read the parts of the code the change will affect. Note the conventions in use, comparable existing features, and the path the relevant logic takes at runtime.
3. Choose an approach. If more than one is realistic, weigh them in a sentence or two each and commit to one.

Deliver:
- The chosen approach in a few sentences.
- Numbered steps, each saying which files change and how.
- The files that matter most, with path:line where useful.
- Risks, edge cases, and how to check the result (tests to add or run).`,
  },
  'general-purpose': {
    description: 'All-round worker for multi-step jobs that mix investigating with doing: tracking something down across the codebase, or making changes that first need some research. Use it when the search is open-ended or the task includes edits.',
    body:        `You have been handed a task by another Claude Code session. See it through to the end, neither padding it with extras nor leaving it half done.

Working style:
- When you do not know where something lives, cast a wide net; once you do, read only what you need.
- Match the style and structure of the code around you. Change existing files rather than adding new ones, and skip writing documentation unless it was requested.
- Check your own work where possible, such as by running the tests that cover it.

Your last message is everything the requester gets back. Summarise what you did, point to code as path:line, flag anything left unfinished or unchecked, and keep it short.`,
  },
}

export const AGENT_NAMES = Object.keys(TEMPLATES) as AgentName[]

export const ROUTING_GUIDANCE = `# Subagent model routing

When you call the Agent tool, set its \`model\` parameter to the cheapest model that can do the task well:
- \`haiku\`: finding files or symbols, grep-style searches, reading and summarizing code, logs or docs, fetching a page, running a command and reporting its output, small mechanical edits with an exact specification.
- \`sonnet\`: implementing a feature, debugging, refactoring across files, writing tests, reviewing code, planning an implementation.
- Leave \`model\` unset, so the subagent uses your own model, only when the task needs your full capability: subtle architecture, security or concurrency reasoning, ambiguous high-stakes problems, or when the user asks for the strongest model.

If a cheaper subagent comes back with weak or incomplete results, retry once with the next model up instead of redoing the work yourself.`

export type AgentName = 'Explore' | 'Plan' | 'general-purpose'

export type AgentModels = Record<AgentName, string>

type AgentTemplate = {
  description:      string
  disallowedTools?: string[]
  omitClaudeMd?:    boolean
  body:             string
}

export type SyncChange = {
  agent:  AgentName
  action: 'written' | 'removed' | 'skipped'
  path:   string
}


/** The model to write for an option value, or undefined to leave the built-in alone. */
export function normalizeModel (value: string): string | undefined {
  const model = value.trim()
  return OFF.has(model.toLowerCase()) ? undefined : model
}

export function renderAgent (name: AgentName, model: string): string {
  const template = TEMPLATES[name]
  const lines    = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(template.description)}`,
    `model: ${model}`,
  ]
  if (template.disallowedTools)
    lines.push(`disallowedTools: ${template.disallowedTools.join(', ')}`)
  if (template.omitClaudeMd)
    lines.push('omitClaudeMd: true')
  lines.push(MARKER, '---', '', `<!-- Written by the system-prompt Claude Code plugin. Edits are overwritten; delete the ${MARKER.split(':')[0]} line to keep your own version. -->`, '', template.body, '')
  return lines.join('\n')
}

function readText (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return undefined
  }
}

/**
 * Brings `<agentsDir>/<Name>.md` in line with the configured models. Only
 * files that carry MARKER (or do not exist) are touched.
 */
export function syncAgents (agentsDir: string, models: AgentModels): SyncChange[] {
  const changes: SyncChange[] = []
  for (const agent of AGENT_NAMES) {
    const path     = join(agentsDir, `${agent}.md`)
    const existing = readText(path)
    const model    = normalizeModel(models[agent])
    const desired  = model ? renderAgent(agent, model) : undefined

    if (existing !== undefined && !existing.includes(MARKER)) {
      if (desired)
        changes.push({ agent, action: 'skipped', path })
      continue
    }
    if (desired === undefined) {
      if (existing !== undefined) {
        rmSync(path, { force: true })
        changes.push({ agent, action: 'removed', path })
      }
      continue
    }
    if (existing !== desired) {
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(path, desired)
      changes.push({ agent, action: 'written', path })
    }
  }
  return changes
}

/** One line for the user, or '' when nothing worth mentioning happened. */
export function describeChanges (changes: SyncChange[]): string {
  const written         = changes.filter(change => change.action !== 'skipped')
  const skipped         = changes.filter(change => change.action === 'skipped')
  const parts: string[] = []
  if (written.length > 0)
    parts.push(`updated subagent overrides (${written.map(change => `${change.agent} ${change.action}`).join(', ')}); they apply from the next session`)
  if (skipped.length > 0)
    parts.push(`left your own ${skipped.map(change => change.path).join(', ')} untouched`)
  return parts.length > 0 ? `system-prompt: ${parts.join('; ')}.` : ''
}
