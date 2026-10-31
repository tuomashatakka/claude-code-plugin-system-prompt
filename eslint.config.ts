import { defineConfig, globalIgnores } from 'eslint/config'
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import config from '@tuomashatakka/eslint-config'


export default defineConfig([
  globalIgnores([ 'node_modules/', 'bun.lock' ]),
  {
    name:          'project/linter-options',
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs:     'error',
    },
  },
  config,
  {
    name:     'project/json',
    files:    [ '**/*.json' ],
    ignores:  [ 'tsconfig.json' ],
    plugins:  { json },
    language: 'json/json',
    extends:  [ 'json/recommended' ],
  },
  {
    name:     'project/jsonc',
    files:    [ 'tsconfig.json' ],
    plugins:  { json },
    language: 'json/jsonc',
    extends:  [ 'json/recommended' ],
  },
  {
    name:     'project/markdown',
    files:    [ '**/*.md' ],
    plugins:  { markdown },
    language: 'markdown/gfm',
    extends:  [ 'markdown/recommended' ],
  },
])
