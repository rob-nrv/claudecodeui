package ai.cloudcli.runtimecontroller

/**
 * Builds the `bash -lc` script body proot-distro runs for a `cloudcli runtime <verb>`
 * invocation. Pure string assembly — no Android dependency — so it's covered by a
 * plain JVM unit test, same as [RuntimeController].
 *
 * NODE BOOTSTRAP, why it exists:
 *
 * A `bash -lc` login shell sources `~/.profile`, which (on this distro, and on
 * stock Debian/Ubuntu generally) sources `~/.bashrc`. But the default
 * `~/.bashrc` opens with
 * ```
 * case $- in
 *     *i*) ;;
 *       *) return;;
 * esac
 * ```
 * which bails out before reaching whatever a version manager's installer
 * appended at the bottom of that same file — nvm's loader block among them.
 * `$-` never contains `i` for a login-but-non-interactive shell, so that guard
 * always fires and `node` never reaches PATH, even though the identical shell
 * works fine interactively (`bash -ic`), and even though `~/.profile` itself
 * has no such guard. Confirmed on-device: `bash -lc '...'` -> "node: command
 * not found"; `bash -ic '...'` -> works, but leaks job-control stderr noise
 * ("cannot set terminal process group", "no job control in this shell") from
 * trying to set up a controlling terminal RUN_COMMAND never gives it — not
 * something to depend on for a non-interactive plugin invocation.
 *
 * Fix: don't depend on any rc file being sourced at all. Statically add the
 * stable, non-dynamic bin/shim directories the common per-user Node
 * toolchains expose once installed (Volta, fnm, asdf, mise all keep one; only
 * nvm requires active per-shell sourcing to put a version on PATH — a
 * well-known nvm design tradeoff, not a bug here) and, only if `node` still
 * isn't resolvable after that, source nvm.sh directly the same way nvm's own
 * docs recommend for non-interactive scripts. `bash -lc` is kept (not `-c` or
 * `-i`) so the rest of the login-shell environment this container's
 * `/etc/profile` sets up (locale, Termux's own PATH entry, the Android
 * ART/dalvik vars proot-distro injects) is preserved exactly as before —
 * this only fixes the one broken step, it does not change how the shell is
 * invoked otherwise.
 */
object TermuxCommandBuilder {

    /**
     * Directories the common per-user Node version managers put a *stable*
     * dispatcher/shim binary in once a default/global version is set — no
     * `eval $(...)` or sourcing required, just needing to be on PATH. nvm is
     * deliberately not listed here: it has no such static entry, which is
     * why it gets the explicit nvm.sh fallback below instead.
     */
    private val STATIC_NODE_TOOLCHAIN_DIRS = listOf(
        "\$HOME/.volta/bin",
        "\$HOME/.local/share/fnm",
        "\$HOME/.fnm",
        "\$HOME/.asdf/shims",
        "\$HOME/.local/share/mise/shims",
        "\$HOME/.local/bin",
    )

    val NODE_BOOTSTRAP: String = buildString {
        append("for __cc_dir in ")
        append(STATIC_NODE_TOOLCHAIN_DIRS.joinToString(" ") { "\"$it\"" })
        append("; do\n")
        append("  [ -d \"\$__cc_dir\" ] && case \":\$PATH:\" in *\":\$__cc_dir:\"*) ;; *) PATH=\"\$__cc_dir:\$PATH\" ;; esac\n")
        append("done\n")
        append("unset __cc_dir\n")
        append("if ! command -v node >/dev/null 2>&1; then\n")
        append("  export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"\n")
        append("  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"\n")
        append("fi")
    }

    /**
     * Single-quotes [value] for safe use as one shell word: closes the quote,
     * appends a literally-escaped quote, reopens it. Same idiom proot-distro's
     * own `env.py` uses for values it writes into shell scripts. Unlike double
     * quotes, this leaves no `$`, backtick, or `\` in [value] able to be
     * interpreted by the shell — appropriate for a value that is arbitrary
     * user-typed settings text, not a shell expression.
     */
    fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    /**
     * The full `bash -lc` script body: Node bootstrap, then `cd` into
     * [repoPath] and run `cloudcli runtime [verb] --json`. Only ever prints to
     * stdout what that final command prints — the bootstrap itself is silent
     * on both streams, so a caller parsing stdout as JSON never has to look
     * past it.
     */
    fun buildInnerCommand(repoPath: String, verb: String): String =
        "$NODE_BOOTSTRAP\n" +
            "cd ${shellQuote(repoPath)} && exec node dist-server/server/modules/cli/cli.js runtime ${shellQuote(verb)} --json"

    /**
     * The `bash -lc` script body for a long-running server launch: Node
     * bootstrap, then `cd` into [repoPath] and `exec` the built server entry
     * directly — `dist-server/server/index.js`, the exact file `npm run
     * server` runs and `resolveServerEntryPath` (runtime.module.ts) resolves
     * to. Deliberately never `cloudcli runtime start`: that CLI process would
     * itself become this session's main command, and `proot-distro login`
     * always passes `--kill-on-exit` on Termux, which SIGKILLs every
     * remaining tracee — including a detached server child — the instant its
     * main command exits (confirmed device diagnosis: C2-P1-L02-D01). `exec`,
     * not a backgrounded `&`, so the server process itself replaces `bash` as
     * that main command, and this proot session lives exactly as long as the
     * server does.
     */
    fun buildServerLaunchCommand(repoPath: String): String =
        "$NODE_BOOTSTRAP\n" +
            "cd ${shellQuote(repoPath)} && exec node dist-server/server/index.js"
}
