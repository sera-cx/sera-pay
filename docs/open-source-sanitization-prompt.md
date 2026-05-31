# Open Source Sanitization Prompt

Use this prompt before publishing the repository or before every release branch.

```text
You are doing a deep pre-open-source security and cleanup review for this repository.

Goal:
- Confirm no private backend implementation detail, credential, token, .env value, private URL, private deployment config, database URL, webhook secret, API key, JWT key, session secret, cloud storage credential, or production-only identifier is committed.
- Keep the application runnable after sanitization.
- Remove generated, unused, local-only, or obsolete files only when they are clearly not required by build, test, runtime, deployment, or documentation.

Required checks:
1. Inventory tracked files:
   - Run `git status --short --branch`.
   - Run `git ls-files`.
   - Verify `.env`, `.env.*`, logs, build output, node_modules, coverage, local caches, and private deployment files are not tracked.
2. Check ignored local files:
   - Run `git status --ignored --short`.
   - Confirm ignored files are expected local artifacts only.
3. Scan current tracked content:
   - Search for secret names and values: PRIVATE_KEY, SECRET, API_KEY, ACCESS_KEY, TOKEN, PASSWORD, DATABASE_URL, POSTGRES, WEBHOOK, AWS, S3, R2, PRIVY, ALCHEMY, JWT, SESSION, BEARER.
   - Search for known secret formats: private-key blocks, AWS AKIA keys, GitHub ghp tokens, OpenAI sk tokens, Slack xox tokens, long base64-like strings, JWT-looking values, and database connection strings.
   - Treat placeholder-only entries in `.env.example` as allowed.
4. Scan Git history:
   - Run `git log --all -- .env .env.*`.
   - Run a history secret scanner such as `gitleaks detect --source . --no-git=false --redact` or `trufflehog git file://. --only-verified`.
   - If any real secret ever appears in history, rotate that secret and rewrite history before publishing.
5. Check frontend boundary:
   - Confirm only `VITE_` variables are exposed to browser code.
   - Confirm server-only values are read only by `server/`, build scripts, or deployment runtime.
   - Inspect generated browser bundles for secret-like strings after `pnpm run build`.
6. Check hardcoded URLs and identifiers:
   - Public product URLs are allowed.
   - Private dashboards, session upload URLs, internal project IDs, GraphQL endpoints, and vendor endpoints with embedded project identifiers must be moved to environment variables or removed.
7. Check cleanup candidates:
   - Remove local generated folders such as `dist/`, `coverage/`, logs, nested `node_modules/`, and temporary files.
   - Remove sample/demo files only if no script, import, or docs reference them.
8. Verify runtime:
   - Run `pnpm install` if dependencies are missing.
   - Run `pnpm run check`.
   - Run `pnpm test`.
   - Run `pnpm run build`.
   - If a test requires an optional real API key, confirm it skips cleanly when the key is absent.

Output:
- List high-risk findings first, with file paths and line numbers.
- State exactly what was changed or removed.
- State what still needs manual action, especially secret rotation or Git history rewriting.
- State the verification commands and whether they passed.
```

Manual release rule: if a real secret has ever been committed, do not publish until that credential is rotated at the provider and removed from Git history.
