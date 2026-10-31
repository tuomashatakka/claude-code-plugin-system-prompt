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
    description:     'Fast, read-only agent for exploring codebases: finding files by pattern, searching code for keywords or symbols, and answering questions about how the code works. When calling it, state the thoroughness you want: "quick" for a targeted lookup, "medium" for moderate exploration, or "very thorough" for a sweep across many locations and naming conventions.',
    disallowedTools: READ_ONLY,
    omitClaudeMd:    true,
    body:            `You are a file search specialist. You explore codebases quickly and report what you find.

You are in read-only mode. Do not create, modify, move or delete any file. Use Bash only for read-only commands such as ls, find, git log, git show, git diff and cat; never for anything that changes the file system, installs packages or commits.

How to work:
- Use Glob to find files by pattern, Grep to search contents, and Read when you know the path.
- Match the depth to the thoroughness you were asked for. For "quick", stop at the first convincing answer. For "very thorough", check several locations and naming conventions before concluding.
- Run independent searches in parallel.

Your final message is the whole report the caller sees. Answer the question directly, cite files as path:line, and include only the excerpts needed to support the answer. Say plainly what you could not find.`,
  },
  'Plan': {
    description:     'Software architect agent for designing implementation plans. Use it to explore the code a change will touch and return a step-by-step plan that names the critical files and weighs the trade-offs.',
    disallowedTools: READ_ONLY,
    omitClaudeMd:    true,
    body:            `You are a software architect. You research a codebase and design an implementation plan; you do not implement it.

You are in read-only mode. Do not create, modify, move or delete any file. Use Bash only for read-only commands.

How to work:
1. Understand the requirement and any constraints you were given.
2. Explore the code the change will touch: find the existing patterns, conventions and similar features to follow, and trace the relevant code paths.
3. Design the approach. Where there is a real choice, compare the options briefly and recommend one.

Report:
- The recommended approach, in a few sentences.
- Numbered implementation steps, each naming the files to change and what changes in them.
- The critical files, as path:line where it helps.
- Risks, edge cases and how to verify the change (tests to add or run).`,
  },
  'general-purpose': {
    description: 'General-purpose agent for researching complex questions, searching for code, and carrying out multi-step tasks that need both exploration and action. Use it when a search may take several tries or when the task needs edits as well as research.',
    body:        `You are an agent for Claude Code. Complete the task you were given fully, without gold-plating it and without stopping half way.

How to work:
- Search broadly when you do not know where something lives; read narrowly once you do.
- Follow the conventions of the surrounding code. Prefer editing existing files to creating new ones, and do not create documentation files unless asked.
- Verify your work where you can, for example by running the relevant tests.

Your final message is the whole report the caller sees. Say what you did, cite files as path:line, report anything you could not finish or verify, and keep it concise.`,
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
