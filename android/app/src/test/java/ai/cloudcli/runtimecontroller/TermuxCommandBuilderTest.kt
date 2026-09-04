package ai.cloudcli.runtimecontroller

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for [TermuxCommandBuilder] — the fix for the field-confirmed
 * bug where `bash -lc` never put `node` on PATH (see the class doc for the root
 * cause: Debian's default `~/.bashrc` returns before reaching nvm's loader block
 * for any non-interactive shell, login or not).
 */
class TermuxCommandBuilderTest {

    @Test
    fun `bootstrap only mutates PATH and env, never writes to stdout or stderr`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        // No echo/printf and no unredirected command whose output could land on
        // stdout ahead of the CLI's own JSON, or on stderr ahead of a real error.
        assertFalse(bootstrap.contains("echo"))
        assertFalse(bootstrap.contains("printf"))
    }

    @Test
    fun `bootstrap does not depend on any rc file or interactive shell state`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        assertFalse(bootstrap.contains(".bashrc"))
        assertFalse(bootstrap.contains(".profile"))
        assertFalse(bootstrap.contains("\$-")) // no interactive-flag check
    }

    @Test
    fun `bootstrap falls back to sourcing nvm sh only when node is not already resolvable`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        assertTrue(bootstrap.contains("command -v node"))
        assertTrue(bootstrap.contains("nvm.sh"))
        // Guarded by -s (exists and non-empty), so a machine with no nvm install
        // just skips the line rather than failing.
        assertTrue(bootstrap.contains("[ -s \"\$NVM_DIR/nvm.sh\" ]"))
    }

    @Test
    fun `bootstrap does not hardcode a home directory or a node binary path`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        assertFalse(bootstrap.contains("/home/"))
        assertFalse(bootstrap.contains("/root/"))
        assertTrue(bootstrap.contains("\$HOME"))
    }

    @Test
    fun `buildInnerCommand ends with a bare node invocation after cd, so PATH resolution applies`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/projects/claudecodeui", "status")
        assertTrue(command.trim().endsWith("--json"))
        assertTrue(command.contains("exec node dist-server/server/modules/cli/cli.js runtime 'status' --json"))
    }

    @Test
    fun `repoPath is single-quoted so a plain path round-trips unquoted`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/projects/claudecodeui", "status")
        assertTrue(command.contains("cd '/home/robin/projects/claudecodeui' &&"))
    }

    @Test
    fun `repoPath with a space is preserved as one argument`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/my projects/claudecodeui", "status")
        assertTrue(command.contains("cd '/home/robin/my projects/claudecodeui' &&"))
    }

    @Test
    fun `repoPath with an embedded single quote is escaped, not left to break out of the quoting`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/it's-a-repo", "status")
        assertTrue(command.contains("cd '/home/robin/it'\\''s-a-repo' &&"))
    }

    @Test
    fun `repoPath with a dollar sign is not expanded — single quotes suppress shell expansion`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/\$(whoami)", "status")
        // The whole path is inside single quotes, so $(...) is inert literal text
        // to the shell, never command substitution.
        assertTrue(command.contains("cd '/home/robin/\$(whoami)' &&"))
    }

    @Test
    fun `repoPath with a backtick is not expanded — single quotes suppress shell expansion`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/`id`", "status")
        assertTrue(command.contains("cd '/home/robin/`id`' &&"))
    }

    @Test
    fun `verb is quoted the same way and passed through unchanged for each known verb`() {
        for (verb in listOf("status", "start", "stop")) {
            val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/projects/claudecodeui", verb)
            assertTrue(command.contains("runtime ${TermuxCommandBuilder.shellQuote(verb)} --json"))
        }
    }

    @Test
    fun `shellQuote round-trips a value containing every special character exercised above`() {
        val value = "a'b\$c`d\"e f"
        val quoted = TermuxCommandBuilder.shellQuote(value)
        // Must start and end with a single quote, and the only way a raw `'`
        // appears mid-string is via the close-escape-reopen idiom.
        assertTrue(quoted.startsWith("'"))
        assertTrue(quoted.endsWith("'"))
        assertEquals("'a'\\''b\$c`d\"e f'", quoted)
    }

    @Test
    fun `bootstrap is prepended before the cd, so PATH is fixed up before node is invoked`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/projects/claudecodeui", "start")
        val bootstrapEnd = command.indexOf(TermuxCommandBuilder.NODE_BOOTSTRAP) + TermuxCommandBuilder.NODE_BOOTSTRAP.length
        val cdStart = command.indexOf("cd '")
        assertTrue(bootstrapEnd > 0)
        assertTrue(cdStart > bootstrapEnd)
    }

    // ---- buildServerLaunchCommand: the long-running direct server launch ----

    @Test
    fun `server launch execs the built server entry directly, never cli runtime start`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        assertTrue(command.trim().endsWith("exec node dist-server/server/index.js"))
        assertFalse(command.contains("cli.js"))
        assertFalse(command.contains("runtime"))
    }

    @Test
    fun `server launch command matches the exact entry npm run server uses`() {
        // dist-server/server/index.js is the literal target of the "server" script
        // in package.json, and of resolveServerEntryPath in runtime.module.ts —
        // this must never drift from that real repo path.
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        assertTrue(command.contains("node dist-server/server/index.js"))
    }

    @Test
    fun `server launch also bootstraps Node first, same as the CLI-verb command`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        val bootstrapEnd = command.indexOf(TermuxCommandBuilder.NODE_BOOTSTRAP) + TermuxCommandBuilder.NODE_BOOTSTRAP.length
        val cdStart = command.indexOf("cd '")
        assertTrue(bootstrapEnd > 0)
        assertTrue(cdStart > bootstrapEnd)
    }

    @Test
    fun `server launch repoPath is quoted the same way as the CLI-verb command`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/it's-a-repo")
        assertTrue(command.contains("cd '/home/robin/it'\\''s-a-repo' &&"))
    }

    @Test
    fun `server launch uses exec, not a backgrounded ampersand, so the server is the session's main command`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        assertTrue(command.contains("&& exec node"))
        assertFalse(command.trim().endsWith("&"))
    }

    // ---- TERMUX_NODE_SHADOWING regression (C2-R1-L01) ----
    //
    // Field failure: STATUS and STOP worked while START always ended in
    // "CloudCLI started but never became healthy" and left no process behind.
    // Cause: proot-distro's own /etc/profile.d/termux-profile.sh appends
    // Termux's bin dir to PATH in every login shell, so inside the distro
    // `command -v node` found Termux's Android/bionic node. The pure-JS CLI
    // verbs ran fine under it; the server entry loads better-sqlite3 and died
    // instantly on ERR_DLOPEN_FAILED. Reproduced on-device before this fix.

    @Test
    fun `bootstrap treats a Termux-provided node as no node at all`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        // The version-manager fallback must be reachable when the only node on
        // PATH lives under Termux's prefix, not just when there is none.
        assertTrue(bootstrap.contains("''|${RuntimeConfig.TERMUX_PREFIX}/*)"))
        // The bare test this replaced is satisfied by Termux's node, which is
        // exactly how the wrong interpreter got through.
        assertFalse(bootstrap.contains("if ! command -v node"))
    }

    @Test
    fun `bootstrap still resolves a distro node without touching the version-manager fallback`() {
        val bootstrap = TermuxCommandBuilder.NODE_BOOTSTRAP
        // A node anywhere outside the Termux prefix matches no case branch, so
        // nvm.sh is never sourced — an apt-installed /usr/bin/node keeps working.
        assertTrue(bootstrap.contains("case \"\$(command -v node 2>/dev/null)\" in"))
        assertTrue(bootstrap.contains("nvm.sh"))
        assertTrue(bootstrap.contains("esac"))
    }

    @Test
    fun `bootstrap does not hardcode the Termux prefix separately from RuntimeConfig`() {
        // One definition of where Termux lives; the launcher and the bootstrap
        // must never be able to disagree about it.
        assertTrue(TermuxCommandBuilder.NODE_BOOTSTRAP.contains(RuntimeConfig.TERMUX_PREFIX))
    }

    // ---- launch diagnostics ----

    @Test
    fun `server launch names the resolved node on stderr only`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        assertTrue(command.contains(TermuxCommandBuilder.NODE_ECHO_LINE))
        assertTrue(TermuxCommandBuilder.NODE_ECHO_LINE.endsWith(">&2"))
        // The shared bootstrap stays silent — this line is the launch command's
        // alone, so the CLI verbs' stdout remains pure JSON.
        assertFalse(TermuxCommandBuilder.NODE_BOOTSTRAP.contains(TermuxCommandBuilder.NODE_ECHO_LINE))
    }

    @Test
    fun `the node diagnostic prints only a path, never environment values`() {
        val line = TermuxCommandBuilder.NODE_ECHO_LINE
        assertTrue(line.contains("command -v node"))
        // No env/set/printenv dump, and no expansion of anything but the node path.
        assertFalse(line.contains("printenv"))
        assertFalse(line.contains("\$PATH"))
        assertFalse(line.contains("env"))
    }

    @Test
    fun `the CLI-verb command stays silent so its stdout is parseable JSON`() {
        val command = TermuxCommandBuilder.buildInnerCommand("/home/robin/projects/claudecodeui", "status")
        assertFalse(command.contains("printf"))
        assertFalse(command.contains("echo"))
    }

    @Test
    fun `server launch still ends by exec-ing the server, after the diagnostic line`() {
        val command = TermuxCommandBuilder.buildServerLaunchCommand("/home/robin/projects/claudecodeui")
        assertTrue(command.trim().endsWith("exec node dist-server/server/index.js"))
        assertTrue(command.indexOf(TermuxCommandBuilder.NODE_ECHO_LINE) < command.indexOf("cd '"))
    }
}
