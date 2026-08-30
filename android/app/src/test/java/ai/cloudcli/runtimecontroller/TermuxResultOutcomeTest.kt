package ai.cloudcli.runtimecontroller

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for [TermuxResultOutcome] using a *real*
 * `org.json.JSONObject` (see the `testImplementation("org.json:json:...")`
 * dependency added alongside this) — the platform's own copy that this
 * module otherwise compiles against throws "not mocked" for every method in
 * local unit tests, so this path had never actually been exercised before.
 */
class TermuxResultOutcomeTest {

    private fun okResult(stdout: String, exitCode: Int? = 0) = TermuxCommandResult(
        exitCode = exitCode,
        stdout = stdout,
        stderr = "",
        executionError = null,
        bundlePresent = true,
        errCode = TermuxResultParser.ERR_OK,
    )

    @Test
    fun `valid JSON stdout propagates as a Success carrying the parsed value`() {
        val result = okResult("""{"state":"online","reason":"verified","ownedByMarker":true,"instanceId":"i-1","url":"http://127.0.0.1:3001","pid":42}""")

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Success)
        val status = (outcome as AdapterOutcome.Success).value
        assertEquals("online", status.state)
        assertEquals("i-1", status.instanceId)
        assertEquals(42, status.pid)
    }

    @Test
    fun `an executionError short-circuits to a Termux-side Failure without touching stdout`() {
        val result = TermuxCommandResult(
            exitCode = null,
            stdout = """{"state":"online"}""", // must be ignored — Termux itself failed
            stderr = "",
            executionError = "permission not granted",
        )

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Failure)
        val failure = outcome as AdapterOutcome.Failure
        assertEquals("Termux couldn't run that command.", failure.userMessage)
        assertEquals("permission not granted", failure.details)
    }

    @Test
    fun `empty stdout after the Node-not-found failure mode reports exit code and stderr diagnostics`() {
        val result = TermuxCommandResult(
            exitCode = 127,
            stdout = "",
            stderr = "bash: line 5: node: command not found",
            executionError = null,
            bundlePresent = true,
            errCode = TermuxResultParser.ERR_OK,
        )

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Failure)
        val details = (outcome as AdapterOutcome.Failure).details
        assertTrue(details.contains("exited 127"))
        assertTrue(details.contains("bundle=present"))
        assertTrue(details.contains("err=-1"))
        assertTrue(details.contains("bash: line 5: node: command not found"))
    }

    @Test
    fun `empty stdout from a missing repo path is distinguishable via its stderr`() {
        val result = TermuxCommandResult(
            exitCode = 1,
            stdout = "",
            stderr = "bash: cd: /home/robin/projects/claudecodeui: No such file or directory",
            executionError = null,
        )

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Failure)
        assertTrue((outcome as AdapterOutcome.Failure).details.contains("No such file or directory"))
    }

    @Test
    fun `empty stdout diagnostics report an absent bundle distinctly from an empty one`() {
        val result = TermuxCommandResult(
            exitCode = null,
            stdout = "",
            stderr = "",
            executionError = null,
            bundlePresent = false,
            errCode = null,
        )

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        val details = (outcome as AdapterOutcome.Failure).details
        assertTrue(details.contains("bundle=absent"))
        assertTrue(details.contains("exited ?"))
        assertTrue(details.contains("err=none"))
    }

    @Test
    fun `malformed JSON stdout is a Failure, not a crash`() {
        val result = okResult("not json at all")

        val outcome = TermuxResultOutcome.from(result, "status") { RuntimeStatusInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Failure)
        assertTrue((outcome as AdapterOutcome.Failure).userMessage.contains("unexpected response"))
    }

    @Test
    fun `a start result with a nested status object parses through the real parser lambda`() {
        val json = """
            {"outcome":"started","newInstanceId":"i-2","launchError":null,
             "status":{"state":"online","reason":"verified","ownedByMarker":true,"instanceId":"i-2","url":"http://127.0.0.1:3001","pid":7}}
        """.trimIndent()
        val result = okResult(json)

        val outcome = TermuxResultOutcome.from(result, "start") { RuntimeStartResultInfo.fromJson(it) }

        assertTrue(outcome is AdapterOutcome.Success)
        assertEquals("started", (outcome as AdapterOutcome.Success).value.outcome)
    }

    @Test
    fun `the parse lambda actually receives a functioning JSONObject, proving the test dependency works`() {
        val result = okResult("""{"a":1}""")
        val outcome = TermuxResultOutcome.from(result, "status") { json: JSONObject -> json.getInt("a") }
        assertEquals(1, (outcome as AdapterOutcome.Success).value)
    }
}
