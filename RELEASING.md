# Releasing

How changes and versions are shipped. Written for maintainers.

## Every change

1. **Run the checks.**

   ```bash
   npm test && npm run typecheck
   ```

   If you touched an Edge Function, also run `npm run smoke:deno` (needs `deno` installed).

2. **Try it on the staging project** if you changed the SQL or a function. Never test on a production project.

   ```bash
   npm run verify
   npm run demo:attack
   ```

3. **Add a line to `CHANGELOG.md`** under `## [Unreleased]`, in the right group: `Added`, `Changed`, `Fixed`, `Security` or `Removed`. Write it for someone who installed otp-guard, not for yourself.

4. **Commit and push.** CI runs on every push and pull request. Check it with `gh run list --limit 1`.

## Rules that protect people who already installed it

> [!CAUTION]
> **Never edit a migration that has been released.** People already applied it, so `supabase db push` will not run it again: your change would never reach them, and their database would silently differ from yours.

Every database change goes in a **new migration**, named after the version, for example `supabase/migrations/20261015000000_otp_guard_0_2_0.sql`:

- Change functions with `CREATE OR REPLACE FUNCTION`.
- Add new settings to `otp_guard.preset_values()` and finish the migration with
  `SELECT otp_guard.apply_preset('strict', p_overwrite => false);`
  so new keys appear without overwriting values people tuned.
- Keep new tables in the `otp_guard` schema, with RLS enabled, and revoke new `public` functions from `anon` and `authenticated` (copy the privileges block of the first migration).
- Add or update the tests in `tests/sql/`: the harness applies every file in `supabase/migrations/` in order.

Edge Functions are copied into each project, so updates do not reach anyone until they copy the files again. Every release must list which function files changed.

Changing the meaning of an existing setting, a response format or an environment variable is a breaking change: it needs a minor release (`0.x.0`) and an **Upgrading** section explaining what to do.

## Cutting a release

1. **Pick the version.** `0.1.1` for fixes that need nothing from users beyond copying files; `0.2.0` for new features or anything that needs an upgrade step.

2. **Bump it everywhere it appears:**

   | File | Where |
   |---|---|
   | `package.json` | `version` |
   | `packages/client/package.json` | `version`, only if the client changed |
   | The new migration | redefine `public.otp_guard_status()` so it reports the new version |
   | `README.md` | the status badge |

3. **Update `CHANGELOG.md`.** Rename `[Unreleased]` to `[0.2.0] - YYYY-MM-DD`, add a fresh empty `[Unreleased]` above it, and update the comparison links at the bottom. List:
   - what changed, grouped;
   - **Files**: the new migration and every function file that changed;
   - **Upgrading**, if anything is needed beyond copying files and running `supabase db push`.

4. **Commit and push.**

   ```bash
   git commit -am "Release v0.2.0"
   git push
   ```

   Wait for CI to pass.

5. **Create the GitHub release**, using that version's section of the changelog as the notes:

   ```bash
   gh release create v0.2.0 --title "v0.2.0" --notes-file notes.md --prerelease
   ```

   Keep `--prerelease` while the version is `0.x`.

6. **Publish the client** if it changed:

   ```bash
   npm publish --workspace @otp-guard/client
   ```

## After a release

- Confirm the release page and the notes read well.
- If the release fixes a security problem, say so plainly in the notes under **Security**, with what an affected project should do.
