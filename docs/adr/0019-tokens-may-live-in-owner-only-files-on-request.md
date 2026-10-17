# Tokens and credentials may live in owner-only files, on request

By default, the MSAL token cache and every app-only or blueprint credential go to the OS keychain: Keychain on macOS, Credential Manager on Windows, and the Secret Service on Linux. Setting `GRAPHSLAYER_SECRET_STORE=file` puts them in `~/.graphslayer/msal-cache.json` and `~/.graphslayer/secrets.json` instead. Both files are mode 0600 in a 0700 directory, and nothing is encrypted (#10).

A headless Linux host usually has no unlocked Secret Service keyring, so graphslayer can't start there. To work at all, a keyring on such a host has to unlock itself at boot, from a stored password or with none. Then it protects the tokens no better than an owner-only file. In both cases, any process running as the same user can read them, and anyone holding the disk or a backup can read them too. Microsoft accepts the same trade-off on Linux: Azure CLI keeps its MSAL token cache "as plaintext files on Linux and macOS", and MSAL Node Extensions offers `usePlaintextFileOnLinux` for when libsecret fails.

## Considered options

- **Fall back to files when the keychain fails, as `usePlaintextFileOnLinux` does.** Rejected. A desktop whose keyring is locked for a moment would quietly start writing tokens in plain text, and nobody would have chosen that.
- **Encrypt the files with a key kept beside them.** Rejected. The key sits next to the files, so it adds nothing against anyone who can read them.
- **Keep the keychain only, and document unlocking it at boot.** Rejected. It needs a password stored on disk or a blank one, which gives the same protection as an owner-only file, with D-Bus and a daemon in front of it.

## Consequences

What limits the damage from a stolen token is what the token can do: a read-only connection, Conditional Access on the identity, and Microsoft's logs (ADR-0016). Where it is kept matters less. The keychain stays the default, because on a desktop it does protect against other users and against copied disks while the keyring is locked.
