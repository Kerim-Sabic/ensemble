// The project's update-signing public key (Ed25519, PEM), built into every copy of the app.
// Empty means updates are installed as before (checked by GitHub's HTTPS and the installer's
// SHA-512 from latest.yml only), and the app writes a line saying so in its log.
//
// `node scripts/update-keys.mjs` makes a key pair, writes the public half here and tells you
// where the private half goes (a GitHub secret named ENSEMBLE_UPDATE_KEY). Once a key is here,
// every later release must be signed with it: the release workflow refuses to publish otherwise,
// because installed copies would refuse the update.
export const UPDATE_PUBLIC_KEY = ``

// macOS installs updates through Squirrel.Mac, which only accepts an app signed with an Apple
// Developer ID. Until the Mac builds are signed, the app on a Mac does not update itself and the
// README asks people to download new versions from the releases page.
export const MAC_SELF_UPDATE = false
