# Releasing GHOST Community Edition

This is the maintainer release process for **GHOST Community Edition**. It is
deliberately source-only: a release is a tagged, reviewed source snapshot plus
release notes — never binaries, models, voices or vendor cores.

## 1. What a release contains

- The reviewed source tree at the release commit (README, docs, the three
  components, scripts, tests, community files).
- Release notes copied from the matching [CHANGELOG](../CHANGELOG.md) section.
- Nothing else: no Live2D model binaries/textures, no Live2D Cubism Core, no
  VoxCPM weights, no reference voices/audio, no prebuilt browser bundles
  (`lib/client.js`, `lib/window.js`), no `node_modules/`, no Electron, no runtime
  `data/` or logs.

GitHub's automatically generated source archives (`Source code (zip)` /
`Source code (tar.gz)`) are the only release artifacts. Do not upload build
outputs as release assets.

Versioned packages: none are published to npm or PyPI from this repository. The
DSH bundles are private `@local/*` packages linked from a profile, and
`voice-plugin/` is a snapshot of the upstream `@deepseek-ai/dsh-tool-tts` artifact —
do not republish it.

## 2. Versioning

- The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
  with an explicit 0.x caveat: while the major version is `0`, **minor releases may
  contain breaking changes** and patch releases contain fixes only.
- Keep these versions in sync for a release:
  - `live2d-pet/packages/bundle/package.json` (`@local/dsh-live2d-bundle`)
  - `live2d-pet/packages/plugin/package.json` (`@local/dsh-live2d`)
  - `live2d-pet/tools/live2d-window/package.json` (private Electron launcher)
  - `tts-bridge/bundle/package.json` (`@local/dsh-live2d-tts-bridge`)
- Do **not** change `voice-plugin/package.json` (upstream `@deepseek-ai/dsh-tool-tts`
  version) or `third_party/soullink-emotion-sdk/package.json` (upstream subset
  version) as part of a release; those track their upstream snapshots.
- Tags use `vMAJOR.MINOR.PATCH` (for example `v0.1.0`). Pre-releases use
  `vX.Y.Z-rc.N` and are marked as pre-releases on GitHub.
- The CHANGELOG is the source of truth for release notes; it uses
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections.

## 3. Pre-release checklist

Work on a clean checkout and run every step; do not skip the scans because "nothing
changed".

### 3.1 Repository state

```bash
git status --short            # must be clean
git switch main
git pull --ff-only origin main
git log --oneline -5          # confirm the intended head
```

### 3.2 Offline tests (same as CI)

```bash
set -euo pipefail

# JS/ESM syntax check over hand-written files, vendor *.min.js excluded
find . -type f \( -name '*.js' -o -name '*.mjs' \) \
  ! -name '*.min.js' ! -path './.git/*' ! -path '*/node_modules/*' \
  -print0 | while IFS= read -r -d '' f; do node --check "$f"; done

# Offline node:test suites
node --test live2d-pet/tests/test_sse_backpressure.mjs live2d-pet/tests/test_window_singleton.mjs

# Python byte-compilation
python3 -m compileall -q voice-plugin/python live2d-pet/packages/plugin/python
```

Also run, when the local environment has the extra setup they need, the full local
suites: `live2d-pet/tests/test_envelope.mjs`, `live2d-pet/tests/test_shim_bridge.mjs`,
`live2d-pet/tests/test_shim.py` and the `voice-plugin/python/tests/` suite. Record
what was run and anything skipped.

### 3.3 Build check

The browser build needs the EULA-gated proprietary Cubism cores. If you have read
and accepted the Live2D EULA, fetch/verify the runtime and build:

```bash
node scripts/fetch-vendor.mjs --accept-live2d-eula   # verifies committed MIT files, fetches the cores
node scripts/build-all.mjs                           # requires esbuild; verifies the vendor lock again
git status --short                                   # only your intended source/doc edits
```

The cores and the browser build outputs (`lib/client.js`, `lib/window.js`) are
gitignored. They must remain untracked, and the proprietary cores must not exist in
the tracked tree.

If you have **not** accepted the Live2D EULA (or the cores are absent), skip this
build step and record that the browser bundles were last built by a maintainer who
can accept it. Note that plain `node scripts/fetch-vendor.mjs` exits non-zero by
design in that case: it verifies the committed MIT files and then refuses to fetch
proprietary code.

### 3.4 Exclusion check (models / cores / voices / weights)

```bash
git ls-files | grep -E '(^|/)(live2dcubismcore\.min\.js|live2d\.min\.js|client\.js|window\.js|manifest\.json)$|\.(moc3|model3?\.json|wav|mp3|m4a|exp3\.json|motion3\.json)$|(^|/)node_modules/|(^|/)data/' \
  && echo 'FORBIDDEN ARTIFACT TRACKED' || echo 'exclusion check OK'
```

Also confirm the committed MIT vendor files still match the SHA-256 lock (works
offline and does not need the EULA):

```bash
node -e "const fs=require('fs'),crypto=require('crypto');const lock=JSON.parse(fs.readFileSync('live2d-pet/packages/plugin/vendor/vendor.lock.json','utf8'));const bad=Object.entries(lock.files).filter(([,e])=>e.committed).filter(([,e])=>crypto.createHash('sha256').update(fs.readFileSync(e.file)).digest('hex')!==e.sha256);if(bad.length){console.error('vendor SHA-256 mismatch:',bad.map(([k])=>k).join(', '));process.exit(1)}console.log('committed vendor files match vendor.lock.json')"
```

Expect `committed vendor files match vendor.lock.json` and exit code 0.

If a release adds a third-party component, update `NOTICE` and
[LICENSING.md](LICENSING.md) before tagging.

### 3.5 Secret / PII / absolute-path scan

The scan patterns live in this document, so exclude it from its own grep:

```bash
# Machine-local absolute paths.
git grep -n -I -E '([A-Za-z]:[\\/]Users[\\/])|(/home/[A-Za-z0-9._-]+/)|(/Users/[A-Za-z0-9._-]+/)' \
  -- . ':!docs/RELEASING.md' && echo 'LOCAL PATH FOUND' || echo 'absolute-path scan OK'

# Credential-shaped strings and private keys. The pattern fragments are split so
# this document does not itself look like leaked credentials to scanners.
git grep -n -I -E '((ghp|github_pat)_[A-Za-z0-9]{20,}|s[k]-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)' \
  -- . ':!docs/RELEASING.md' && echo 'SECRET FOUND' || echo 'secret scan OK'

# Commit author identities in the release history (review by eye; no personal
# provider emails, phone numbers or private identifiers).
git log --format='%an <%ae>' | sort -u
```

The only token-like value that may appear is the documented, non-secret loopback
guard `dsh-live2d-local`; it is not a credential and must not be replaced with a
real secret. If any real secret is ever found, stop the release and follow
[SECURITY.md](../SECURITY.md).

### 3.6 Link check

```bash
git ls-files '*.md' | while IFS= read -r f; do
  grep -oE '\]\([^)]+\)' "$f" | sed 's/^](//; s/)$//' | grep -vE '^(https?:|mailto:|#)' | while IFS= read -r t; do
    t="${t%%#*}"
    [ -z "$t" ] && continue
    [ -e "$(dirname "$f")/$t" ] || echo "BROKEN LINK: $f -> $t"
  done
done
```

Expect no `BROKEN LINK` lines. (External links are checked by eye; no network
access is required for a release.)

### 3.7 CHANGELOG and docs

- [ ] `[Unreleased]` items are moved into a new `[X.Y.Z] - YYYY-MM-DD` section with
      the real release date.
- [ ] The release notes mention breaking changes (if any), security-relevant
      changes, and what is not shipped.
- [ ] Versions in the four package manifests match the tag.
- [ ] README/docs do not promise untested platforms or set dates.
- [ ] `SECURITY.md` supported-versions table is still accurate.

### 3.8 CI and review

- [ ] CI is green on the exact release commit (Node syntax, offline tests, Python
      byte-compilation).
- [ ] The release commit is reviewed by a maintainer other than the author where
      possible; record the checklist result in the release pull request.

## 4. Git workflow

1. Land all release changes on `main` through a normal pull request, including the
   CHANGELOG entry and version bumps.
2. Optionally stabilise on a short-lived `release/vX.Y.Z` branch; merge it back to
   `main` before tagging so the tag is reachable from `main`.
3. Create an **annotated** tag on the reviewed commit:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m "GHOST Community Edition v0.1.0"
   ```

   Signing is optional but recommended when a trusted signing key is configured:

   ```bash
   git tag -s v0.1.0 -m "GHOST Community Edition v0.1.0"
   git tag -v v0.1.0        # verify before pushing
   ```

4. Push only after the tag content was reviewed:

   ```bash
   git push origin main
   git push origin v0.1.0
   ```

   Never force-push or move a published tag. If the tag is wrong, stop and follow
   the rollback section below.

## 5. GitHub release

1. *Releases* → *Draft a new release*, choose the tag created above.
2. Title: `GHOST Community Edition v0.1.0` (version must match the tag).
3. Description: copy the matching CHANGELOG section. Add:
   - supported versions / platform statement;
   - license summary (Apache-2.0, third-party notices in `NOTICE`);
   - the "not shipped" reminder (models, Cubism Core, voices, weights);
   - upgrade notes for breaking changes, if any.
4. Target `main`, tick *Set as the latest release* (except for `-rc` tags, which are
   marked *pre-release*).
5. Do not upload build artifacts; leave only the auto-generated source archives.
   If GitHub security advisories are used for a release, reference the advisory.
6. Publish, then continue with post-release verification.

## 6. Post-release verification

```bash
# 1. The tag points at the intended commit and is reachable from main.
git describe --tags --exact-match
git merge-base --is-ancestor v0.1.0 origin/main && echo 'tag is on main'

# 2. The tagged tree excludes proprietary/private artifacts.
git ls-tree -r v0.1.0 --name-only | grep -E '(^|/)(live2dcubismcore\.min\.js|live2d\.min\.js|client\.js|window\.js)$|\.(moc3|model3?\.json|wav|mp3)$|(^|/)node_modules/|(^|/)data/' \
  && echo 'FORBIDDEN ARTIFACT IN TAG' || echo 'tagged tree is clean'

# 3. The release archive is source-only.
git archive --format=tar v0.1.0 | tar -tf - | grep -E 'node_modules|\.moc3$|\.wav$|live2dcubismcore' \
  && echo 'ARCHIVE PROBLEM' || echo 'release archive is source-only'
```

Then open the published release page and check that notes render, links resolve, the
correct tag is shown, and the *Latest release* marker is right. Confirm CI also ran
on the release commit (or on the tag, if a tag trigger exists), and announce the
release in the channel the project uses.

## 7. Rollback, yank and hotfix policy

- **Ordinary defect after release**: do not delete or move the tag. Publish a patch
  release (`vX.Y.Z+1`) with the fix as soon as it is validated; edit the old
  release notes to point at the newer version.
- **Bad or unsafe release** (broken tree, accidental artifact, license/PII problem):
  1. Immediately mark the GitHub release as *pre-release* (and/or convert it to a
     draft) and add a warning at the top of its notes; announce it if users are
     likely to have downloaded it.
  2. Prepare and publish the fixed patch release, then make it the latest release
     and point the old notes at it.
  3. Removing a published release/tag is a last resort reserved for leaked
     proprietary files or secrets, decided by the maintainers. Delete the GitHub
     release first, then the tag (`git tag -d vX.Y.Z`,
     `git push origin :refs/tags/vX.Y.Z`). Do not rewrite `main` history for an
     ordinary release mistake.
  4. If anything confidential leaked, treat it as a security incident per
     [SECURITY.md](../SECURITY.md), rotate the affected credential (none are
     expected to be committed) and note the action in the next release.
- **Hotfix release**: branch from the release tag (`git switch -c hotfix/0.1.1
  v0.1.0`), make the minimal fix with tests, merge to `main`, then tag `v0.1.1`
  following the normal process.
- **Security release**: coordinate through a private GitHub security advisory as
  described in [SECURITY.md](../SECURITY.md); publish the fixed release, then
  publish the advisory and credit the reporter.
- Once users may have consumed a tag, never silently rewrite it — a changed tag is
  worse than a documented regression.

## 8. Release manager responsibilities

- Have push/maintain rights and 2FA enabled on the GitHub account used for the
  release.
- Run the checklist in full, or explicitly delegate and verify each step.
- Keep the release commit, tag, notes and CHANGELOG consistent.
- After publishing, keep an eye on issues and the security inbox for regressions in
  the new release, and start the next `[Unreleased]` section.
