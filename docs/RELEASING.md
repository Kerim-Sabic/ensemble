# Releasing Ensemble

How a release is built, what signs and checks what, and the one-time setup that turns each part on. Every part is optional: with no secrets set, a release is built exactly as before (unsigned) and still carries checksums, an SBOM and a build-provenance attestation.

## To release

Bump `version` in `package.json`, commit, and push a tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) then:

1. **Windows** (`windows-latest`): type-check, `pnpm audit --prod --audit-level high` (a high or critical advisory stops the release), build the NSIS installer, signed if signing secrets exist.
2. **macOS** (`macos-15` for arm64, `macos-15-intel` for x64): build a `.dmg` and a `.zip` each, ad-hoc signed. A Mac failure does not hold back the Windows release.
3. **Publish** (`ubuntu-latest`, the only job that can write):
   - merges the two Mac update feeds into one `latest-mac.yml`;
   - signs the installers with the project's update key (when set up);
   - writes an SPDX SBOM and `SHA256SUMS.txt`;
   - makes a GitHub build-provenance attestation for every file;
   - creates the release.

Every action is pinned to a full commit SHA. Dependabot keeps those pins and the npm packages current ([`.github/dependabot.yml`](../.github/dependabot.yml)). [CI](../.github/workflows/ci.yml) runs the type checks, the audit and `pnpm auto-test` on every push and pull request. [CodeQL](../.github/workflows/codeql.yml) scans the code on pushes to `main`, on pull requests and weekly.

## What signs and checks what

| What | Signed or made by | Checked by | Turned on by |
|---|---|---|---|
| Windows installer (Authenticode) | electron-builder during the release build | Windows SmartScreen when someone runs it | Azure Artifact Signing secrets, or a certificate (`WIN_CSC_LINK`) |
| A Windows update's publisher | the same signature; its publisher name is written into the app | electron-updater: it refuses an update not signed by that publisher | the same as above |
| Any update, by the project key | `scripts/update-sign.mjs` (Ed25519, in the publish job) | the app before it installs an update (`src/main/updatesig.ts`): no signature, a changed file, another version or another key, and the update is refused | the `ENSEMBLE_UPDATE_KEY` secret plus the public key in `src/main/release-key.ts` |
| The Mac app | ad-hoc signature | macOS lets it start; Gatekeeper still asks once | always (an Apple Developer ID would replace it) |
| Downloads, for people | `SHA256SUMS.txt`, `ensemble-<version>.spdx.json`, a GitHub attestation | `Get-FileHash` / `shasum`, `gh attestation verify` (see the README) | always |
| Dependencies | `pnpm audit`, Dependabot, CodeQL | CI and the release | always; Dependabot security updates need the repository setting below |

Without the update key an installed copy logs `updates: no project signing key in this build…` and updates as before: GitHub's HTTPS plus the SHA-512 in `latest.yml`. On a Mac the app does not update itself until the Mac build is signed with a Developer ID (Squirrel.Mac, which installs Mac updates, needs that), and logs that instead.

## One-time setup (Kerim)

None of this has been done. Each step is independent.

### 1. The update key (free, about five minutes)

```bash
node scripts/update-keys.mjs
```

It makes an Ed25519 key pair, writes the public key into `src/main/release-key.ts` and the private key to `~/ensemble-update-key.pem`. Then:

1. Commit `src/main/release-key.ts`.
2. Add the private key as a repository secret: `gh secret set ENSEMBLE_UPDATE_KEY --repo Kerim-Sabic/ensemble < ~/ensemble-update-key.pem`.
3. Keep a copy in a password manager, then delete the file.

From then on every release must be signed with that key. The workflow refuses to publish one that isn't, because installed copies would refuse it. Losing the key means installed copies can only move to a new key through a manual download, so keep the backup.

Changing the key on purpose has the same effect today: each copy knows exactly one key, and each file carries one signature, so copies built with the old key refuse every release signed with the new one. A planned change needs the app to accept both keys for a while, and the release to be signed with both. That is not built yet (found in the 4.0 review, 2026-11-20): build it before the key is ever changed.

Once a release has carried a Windows publisher name (`WIN_PUBLISHER_NAME`), installed copies refuse any update not signed by that publisher, so every later release must be signed. The release workflow stops with an error rather than publish an unsigned build while that variable is set, and only a version tag publishes: a run started by hand builds the installers and stops there.

### 2. Windows code signing (pick one; costs money)

**Azure Artifact Signing** (formerly Trusted Signing), the cheapest route if you qualify:
- **Cost:** about **$9.99 a month** (Basic, 5,000 signatures). Billing starts when the account is created, even if identity validation fails.
- **Who can sign up:** third-party guides say individuals in the **US or Canada**, and organisations in the US, Canada, the EU or the UK. Check Microsoft's current list before paying: an individual in Bosnia and Herzegovina may not qualify.
- **Sources:** [Microsoft product page](https://azure.microsoft.com/en-us/products/artifact-signing), [eligibility as summarised by G.D.G. Software](https://www.gdgsoft.com/faq/azure-trusted-signing-cost-effective-exe-code-signing), [itwriting.com walkthrough](https://www.itwriting.com/blog/12462-getting-started-with-azure-artifact-signing.html).

Setup:
1. Create a pay-as-you-go Azure subscription, an Artifact Signing account, an identity validation and a *Public Trust* certificate profile.
2. Create an app registration with a client secret and give it the profile's *Certificate Profile Signer* role.
3. Add the repository **secrets** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
4. Add the **variables** `AZURE_SIGN_ENDPOINT` (the account's region endpoint, for example `https://weu.codesigning.azure.net`), `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE` and `WIN_PUBLISHER_NAME` (the certificate's subject common name, exactly).

**A certificate from a certificate authority**:
- **Cost:** OV certificates are listed at about **$220 to $440 a year** by resellers ([SSL Dragon](https://www.ssldragon.com/ssl-certificates/code-signing/), [SSL.com eSigner pricing](https://ssl.com/guide/esigner-pricing-for-code-signing/)).
- **The key cannot be a downloadable file:** since June 2023 the private key of a new publicly trusted code-signing certificate must live on a hardware token or a cloud HSM.
- **What that means here:** the `WIN_CSC_LINK` path (a `.pfx` as base64, plus `WIN_CSC_KEY_PASSWORD`) only fits a certificate you can export, so it is wired but likely not usable for a new certificate. A cloud HSM (DigiCert KeyLocker, SSL.com eSigner) needs its own signing tool, which would be added to the release workflow as a custom `sign` step. That step is not written yet.

### 3. macOS signing and notarization (costs money)

- **Cost:** the Apple Developer Program costs **$99 a year** ([Apple's enrollment page](https://developer-rno.apple.com/support/enrollment)).
- **What it adds:** a Developer ID certificate and notarization, so macOS opens the app without the *Open Anyway* step and Mac updates can install themselves.

Not wired yet. The steps when it is time:
1. Export the *Developer ID Application* certificate as a `.p12` and add the Mac job secrets `CSC_LINK` and `CSC_KEY_PASSWORD`.
2. Add an App Store Connect API key as `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
3. In `electron-builder.yml`, remove `identity: "-"`, set `hardenedRuntime: true` and add the entitlements Electron needs (JIT, unsigned executable memory).
4. Set `MAC_SELF_UPDATE = true` in `src/main/release-key.ts`.

### 4. Repository settings (free)

Under *Settings → Code security*:
- Turn on **Dependabot alerts** and **Dependabot security updates**.
- Turn on **Private vulnerability reporting**, which `docs/SECURITY.md` points to.
- Leave CodeQL's *default setup* **off**: this repository uses its own CodeQL workflow, and GitHub rejects workflow results while default setup is on.

## Checking a release yourself

```bash
gh release download vX.Y.Z --repo Kerim-Sabic/ensemble
sha256sum -c SHA256SUMS.txt                                   # every file matches
gh attestation verify Ensemble-Setup-X.Y.Z.exe --repo Kerim-Sabic/ensemble
```
