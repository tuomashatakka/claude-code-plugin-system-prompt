# System Prompt Extension Plugin for Claude Code

Appends your own instructions to Claude's context at the start of every Claude Code session. You set the text in Claude Code's config, either as plain text, as a file path, or both, and per project if you like.

It also keeps subagents cheap: it runs the built-in `Explore`, `Plan` and `general-purpose` subagents on a cheaper model by default, and tells Claude to choose each subagent's model by how hard the task is.

## Install

```text
/plugin install system-prompt --marketplace tuomashatakka/claude-code-plugin-system-prompt
```

From a local checkout:

```text
/plugin marketplace add /path/to/claude-code-plugin-system-prompt
/plugin install system-prompt@system-prompt-extension
```

Claude Code asks for the options when you enable the plugin. Change them later from `/plugin` → **system-prompt** → configure, or edit settings.json directly.

## Options

| Key            | Type    | Default | What it does |
| -------------- | ------- | ------- | ------------ |
| `enabled`      | boolean | `true`  | Turn injection off without losing your settings. |
| `prompt`       | string  | `""`    | Text to append. In the config dialog, write `\n` for a line break. In settings.json it can also be an array of lines. |
| `prompt_file`  | string  | `""`    | File(s) whose contents are appended after `prompt`. Separate several paths with commas. `~` expands to your home folder; relative paths resolve against the project directory. |
| `every_prompt` | boolean | `false` | Also re-inject the content with every message you send. Instructions stick better in long sessions, but it costs tokens on every turn. |
| `model_routing` | boolean | `true` | Add the [subagent routing guidance](#cheaper-subagents) to the injected content. |
| `explore_model` | string | `haiku` | Default model for the built-in `Explore` subagent. User-level only. |
| `plan_model` | string | `sonnet` | Default model for the built-in `Plan` subagent. User-level only. |
| `general_model` | string | `sonnet` | Default model for the built-in `general-purpose` subagent. User-level only. |

A model option takes an alias (`haiku`, `sonnet`, `opus`) or a full model ID such as `claude-haiku-5-5`. Set it to `off` (or `inherit`, or empty) to keep Claude Code's own built-in agent.

## Configuring in settings.json

The options live under `pluginConfigs` in any Claude Code settings file:

```jsonc
// ~/.claude/settings.json: applies everywhere
{
  "pluginConfigs": {
    "system-prompt@system-prompt-extension": {
      "options": {
        "prompt": [
          "Answer in British English.",
          "Prefer small, focused commits."
        ],
        "prompt_file": "~/.claude/my-instructions.md"
      }
    }
  }
}
```

Project settings override user settings, key by key:

| Priority (highest first) | File |
| --- | --- |
| 1 | `<project>/.claude/settings.local.json` (personal, not committed) |
| 2 | `<project>/.claude/settings.json` (shared with the team) |
| 3 | Values Claude Code exports as `CLAUDE_PLUGIN_OPTION_*` |
| 4 | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) |

So a repository can commit `"prompt_file": "docs/agent-rules.md"` in `.claude/settings.json`, and each developer can still add their own text in `settings.local.json`.

The three subagent model options are the exception: only the user-level sources (3 and 4) count, because the agent files they produce apply to every project.

## Cheaper subagents

There are two parts:

1. **Cheaper defaults for the built-in subagents.** A plugin's own agents always get a prefix (`system-prompt:Explore`) and can't replace a built-in. Only a user or project agent with the same bare name can. So the SessionStart hook writes `Explore.md`, `Plan.md` and `general-purpose.md` into `~/.claude/agents/` (or `$CLAUDE_CONFIG_DIR/agents/`) with the configured models. These replace the built-ins with equivalents: `Explore` and `Plan` stay read-only and skip CLAUDE.md, as the built-ins do, while `general-purpose` keeps every tool.
2. **Per-task routing.** With `model_routing` on, the injected content tells Claude to set `model` on each Agent call: `haiku` for searching, reading and simple mechanical work; `sonnet` for implementing, debugging, reviewing and planning; and its own model only for the hardest reasoning. A model given on the call wins over the agent file's default, so cheap defaults and task-based routing work together.

Things to know:

- **Changes apply from the next session.** Claude Code reads the agents directory before the hook runs. The session where a file is written or changed shows a one-line notice, and the new definition takes effect in the next session.
- **Your own files are safe.** Every generated file contains a `managedBy: system-prompt-plugin` line. The hook only writes, rewrites or removes files that have that line. If you already have your own `~/.claude/agents/Explore.md`, it's left alone. To customise a generated file and keep it, delete its `managedBy` line.
- **A project agent still wins.** A project's `.claude/agents/Explore.md` takes precedence over the user-level file.
- **Uninstalling leaves the files behind.** Before you uninstall, set the three model options to `off` and start one session, or delete the files that contain `managedBy: system-prompt-plugin` from `~/.claude/agents/` yourself.

## How it works

Plugins can't rewrite Claude Code's built-in system prompt, so this plugin uses hooks to add to it:

- **SessionStart** (`startup`, `clear`, `compact`): the hook returns your content as `additionalContext`, which Claude Code adds to the model's context as system-level text at the start of the conversation. It runs again after `/clear` and after compaction, so the instructions stay in context. On `resume`, Claude Code replays the text it saved earlier.
- **UserPromptSubmit**: does nothing unless `every_prompt` is on. When it is, it attaches the same content to each prompt.
- **SessionStart** also keeps the subagent override files in sync (see [Cheaper subagents](#cheaper-subagents)).

If a configured file is missing, the hook writes a warning to stderr and goes on with whatever else it has. It never blocks a session.

If you need a true system-prompt replacement for a single run, Claude Code's `--append-system-prompt` / `--system-prompt` CLI flags do that. This plugin is for instructions you want in every session without typing flags.

## Requirements

The hook runs on [Bun](https://bun.sh) (`bun` must be on your `PATH`).

## Development

The hook is dependency-free TypeScript run directly by Bun: `hooks/inject.ts` is the entry point and handles config and injection, and `hooks/agents.ts` holds the subagent templates and the file sync.

```sh
bun install
bun test                  # bun:test
bun run typecheck         # tsc (TypeScript 7)
bun run lint              # ESLint, run under Bun with eslint.config.ts
bun run check             # all of the above
claude plugin validate .
```

TypeScript is installed side by side, as recommended for TypeScript 7: `@typescript/native` provides the `tsc` 7 compiler, and `typescript` is aliased to `@typescript/typescript6` so typescript-eslint keeps the TypeScript 6 API it needs.

Try the hook by hand:

```sh
echo '{"cwd":"'"$PWD"'"}' | CLAUDE_PLUGIN_OPTION_PROMPT='Be terse.' bun hooks/inject.ts SessionStart
```

## License

MIT
