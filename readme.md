# System Prompt Extension Plugin for Claude Code

Appends your own instructions to Claude's context at the start of every Claude Code session. You set the text in Claude Code's config, either as plain text, as a file path, or both, and per project if you like.

## Install

```
/plugin install system-prompt --marketplace tuomashatakka/claude-code-plugin-system-prompt
```

From a local checkout:

```
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

## How it works

Plugins can't rewrite Claude Code's built-in system prompt, so this plugin uses hooks to add to it:

- **SessionStart** (`startup`, `clear`, `compact`): the hook returns your content as `additionalContext`, which Claude Code adds to the model's context as system-level text at the start of the conversation. It runs again after `/clear` and after compaction, so the instructions stay in context. On `resume`, Claude Code replays the text it saved earlier.
- **UserPromptSubmit**: does nothing unless `every_prompt` is on. When it is, it attaches the same content to each prompt.

If a configured file is missing, the hook writes a warning to stderr and goes on with whatever else it has. It never blocks a session.

If you need a true system-prompt replacement for a single run, Claude Code's `--append-system-prompt` / `--system-prompt` CLI flags do that. This plugin is for instructions you want in every session without typing flags.

## Development

The hook is a single dependency-free Node script at `hooks/inject.mjs`.

```
npm test                  # node --test
claude plugin validate .
```

Try the hook by hand:

```
echo '{"cwd":"'"$PWD"'"}' | CLAUDE_PLUGIN_OPTION_PROMPT='Be terse.' node hooks/inject.mjs SessionStart
```

## License

MIT
