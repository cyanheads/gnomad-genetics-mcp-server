# gnomad-genetics-mcp-server - Directory Structure

Generated on: 2026-08-21 23:05:17

```text
gnomad-genetics-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── variant-triage.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── gene-constraint.resource.ts
│   │   │       └── variant.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── gnomad-dataframe-describe.tool.ts
│   │       │   ├── gnomad-dataframe-drop.tool.ts
│   │       │   ├── gnomad-dataframe-query.tool.ts
│   │       │   ├── gnomad-get-coverage.tool.ts
│   │       │   ├── gnomad-get-gene-constraint.tool.ts
│   │       │   ├── gnomad-get-variant.tool.ts
│   │       │   ├── gnomad-list-gene-variants.tool.ts
│   │       │   └── gnomad-search-clinvar.tool.ts
│   │       └── shared-schemas.ts
│   ├── services/
│   │   ├── clinvar/
│   │   │   ├── clinvar-service.ts
│   │   │   └── types.ts
│   │   ├── gnomad/
│   │   │   ├── gnomad-service.ts
│   │   │   ├── queries.ts
│   │   │   └── types.ts
│   │   ├── canvas-accessor.ts
│   │   └── upstream-error.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   │   └── identifiers-and-responses.fuzz.test.ts
│   ├── integration/
│   │   ├── clinvar-boundary.integration.test.ts
│   │   ├── dataframe-tools.integration.test.ts
│   │   ├── gnomad-boundary.integration.test.ts
│   │   ├── known-issues.integration.test.ts
│   │   └── unresolved-correctness.integration.test.ts
│   ├── prompts/
│   │   └── variant-triage.prompt.test.ts
│   ├── resources/
│   │   ├── gene-constraint.resource.test.ts
│   │   └── variant.resource.test.ts
│   ├── services/
│   │   ├── clinvar-service.test.ts
│   │   ├── gnomad-service.test.ts
│   │   ├── upstream-error.test.ts
│   │   └── upstream-leak.e2e.test.ts
│   ├── smoke/
│   │   └── tool-surface.smoke.test.ts
│   └── tools/
│       ├── gnomad-dataframe-describe.test.ts
│       ├── gnomad-dataframe-drop.test.ts
│       ├── gnomad-dataframe-query.test.ts
│       ├── gnomad-get-coverage.test.ts
│       ├── gnomad-get-gene-constraint.test.ts
│       ├── gnomad-get-variant.batch-config.test.ts
│       ├── gnomad-get-variant.test.ts
│       ├── gnomad-list-gene-variants.test.ts
│       └── gnomad-search-clinvar.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
