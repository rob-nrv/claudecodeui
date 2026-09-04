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
 *
 * TERMUX_NODE_SHADOWING, the second half of the same problem (device-diagnosed,
 * C2-R1-L01):
 *
 * proot-distro drops `/etc/profile.d/termux-profile.sh` into every container it
 * builds, and that file appends `/data/data/com.termux/files/usr/bin` to PATH
 * for every login shell. If the user has Termux's own `node` package installed
 * (very common — it is how most people get `node` on Android at all), then
 * inside the distro `command -v node` resolves to *that* binary: an Android
 * build linked against bionic, not the distro's glibc.
 *
 * It runs, which is what made this so hard to see. Pure-JavaScript work is
 * fine under it, so `cloudcli runtime status` and `runtime stop` — which load
 * no native addon — kept working perfectly through RUN_COMMAND, and only the
 * server launch failed. The server entry loads `better-sqlite3`, whose
 * prebuilt `.node` was compiled against the distro's node/glibc; Android's
 * linker refuses to `dlopen` a path outside its permitted namespaces and node
 * exits immediately with ERR_DLOPEN_FAILED. The proot session's main command
 * is gone, so nothing is left in `ps` and the Android side sees only "never
 * became healthy".
 *
 * A manual `proot-distro login` never hit this: an *interactive* shell does
 * reach the nvm block at the bottom of `~/.bashrc`, and nvm prepends its own
 * bin directory to the *front* of PATH, ahead of the Termux entry that
 * `termux-profile.sh` only ever appends.
 *
 * So resolution here must reject a Termux-prefixed `node` the same way it
 * rejects no node at all, and fall through to the version-manager lookup.
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
        // Not `if ! command -v node`: a bare "is node resolvable" test is
        // satisfied by Termux's own node (see TERMUX_NODE_SHADOWING above), so
        // the fallback below has to treat that one as "no node found" too.
        append("case \"\$(command -v node 2>/dev/null)\" in\n")
        append("  ''|${RuntimeConfig.TERMUX_PREFIX}/*)\n")
        append("    export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"\n")
        append("    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"\n")
        append("    ;;\n")
        append("esac")
    }

    /**
     * One stderr line naming the interpreter this launch actually resolved,
     * emitted only by [buildServerLaunchCommand]. Deliberately not part of
     * [NODE_BOOTSTRAP]: the CLI-verb command's stdout is parsed as JSON and
     * its bootstrap must stay silent on both streams.
     *
     * If the server survives, nobody ever reads this — Termux only delivers a
     * command's output when it exits. It exists for the case that matters: a
     * launch that dies during START, where the very first question is
     * "which node ran it", and where TERMUX_NODE_SHADOWING makes the answer
     * non-obvious. A path is not a secret, and no environment values,
     * arguments or tokens are printed alongside it.
     */
    const val NODE_ECHO_LINE: String = "printf '[cloudcli] node=%s\\n' \"\$(command -v node || echo none)\" >&2"

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
            NODE_ECHO_LINE + "\n" +
            "cd ${shellQuote(repoPath)} && exec node dist-server/server/index.js"
}
