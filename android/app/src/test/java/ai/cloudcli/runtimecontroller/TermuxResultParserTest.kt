package ai.cloudcli.runtimecontroller

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for [TermuxResultParser] — the fix for the field-confirmed
 * bug where the receiver looked up Termux's result Bundle under the dotted
 * *names* of termux-app's Java constants instead of their actual short
 * string *values* ("result", "stdout", "stderr", "exitCode", "err",
 * "errmsg"), so every field silently came back missing regardless of what
 * Termux actually returned.
 */
class TermuxResultParserTest {

    private fun source(values: Map<String, Any?>): (String) -> Any? = { key -> values[key] }

    @Test
    fun `extracts stdout from the nested bundle under the real key`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(mapOf(TermuxResultParser.STDOUT_KEY to """{"state":"online"}""")),
        )
        assertEquals("""{"state":"online"}""", result.stdout)
    }

    @Test
    fun `extracts stderr from the nested bundle under the real key`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(mapOf(TermuxResultParser.STDERR_KEY to "bash: node: command not found")),
        )
        assertEquals("bash: node: command not found", result.stderr)
    }

    @Test
    fun `extracts a present exit code`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(mapOf(TermuxResultParser.EXIT_CODE_KEY to 127)),
        )
        assertEquals(127, result.exitCode)
    }

    @Test
    fun `a missing exit code is null, not zero`() {
        val result = TermuxResultParser.parse(bundlePresent = true, source = source(emptyMap()))
        assertNull(result.exitCode)
    }

    @Test
    fun `missing stdout and stderr default to empty strings, not null`() {
        val result = TermuxResultParser.parse(bundlePresent = true, source = source(emptyMap()))
        assertEquals("", result.stdout)
        assertEquals("", result.stderr)
    }

    @Test
    fun `err equal to RESULT_OK is not treated as an execution error even if errmsg is set`() {
        // errmsg can be present-but-empty/stale alongside a clean err; only a
        // non-RESULT_OK err should ever surface as executionError.
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(
                mapOf(
                    TermuxResultParser.ERR_KEY to TermuxResultParser.ERR_OK,
                    TermuxResultParser.ERRMSG_KEY to "",
                ),
            ),
        )
        assertNull(result.executionError)
        assertEquals(TermuxResultParser.ERR_OK, result.errCode)
    }

    @Test
    fun `a non-RESULT_OK err with errmsg surfaces errmsg as the execution error`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(
                mapOf(
                    TermuxResultParser.ERR_KEY to 1,
                    TermuxResultParser.ERRMSG_KEY to "permission not granted",
                ),
            ),
        )
        assertEquals("permission not granted", result.executionError)
        assertEquals(1, result.errCode)
    }

    @Test
    fun `a non-RESULT_OK err without errmsg still surfaces a synthesized execution error`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(mapOf(TermuxResultParser.ERR_KEY to 1)),
        )
        assertTrue(result.executionError!!.contains("err=1"))
    }

    @Test
    fun `missing err entirely is not an execution error`() {
        val result = TermuxResultParser.parse(bundlePresent = true, source = source(emptyMap()))
        assertNull(result.executionError)
        assertNull(result.errCode)
    }

    @Test
    fun `bundlePresent is carried through as a diagnostic, independent of field contents`() {
        val present = TermuxResultParser.parse(bundlePresent = true, source = source(emptyMap()))
        val absent = TermuxResultParser.parse(bundlePresent = false, source = source(emptyMap()))
        assertTrue(present.bundlePresent)
        assertFalse(absent.bundlePresent)
    }

    @Test
    fun `empty stdout with non-empty stderr is preserved as-is, not merged or dropped`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(mapOf(TermuxResultParser.STDERR_KEY to "cd: no such file or directory")),
        )
        assertEquals("", result.stdout)
        assertEquals("cd: no such file or directory", result.stderr)
    }

    @Test
    fun `a full successful result round-trips every field`() {
        val result = TermuxResultParser.parse(
            bundlePresent = true,
            source = source(
                mapOf(
                    TermuxResultParser.STDOUT_KEY to """{"state":"online"}""",
                    TermuxResultParser.STDERR_KEY to "",
                    TermuxResultParser.EXIT_CODE_KEY to 0,
                    TermuxResultParser.ERR_KEY to TermuxResultParser.ERR_OK,
                ),
            ),
        )
        assertEquals("""{"state":"online"}""", result.stdout)
        assertEquals("", result.stderr)
        assertEquals(0, result.exitCode)
        assertNull(result.executionError)
        assertTrue(result.bundlePresent)
    }
}

/**
 * Pure-JVM coverage for [TermuxResultReceiver]'s request correlation — the
 * register/unregister/resolve bookkeeping is plain `ConcurrentHashMap` +
 * `AtomicInteger`, no Android types, so it's exercised directly without
 * needing a real `Intent`.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TermuxResultReceiverCorrelationTest {

    private fun fakeResult(stdout: String) = TermuxCommandResult(
        exitCode = 0,
        stdout = stdout,
        stderr = "",
        executionError = null,
    )

    @Test
    fun `resolving a registered request delivers the result to its own waiter`() {
        val deferred = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val id = TermuxResultReceiver.register(deferred)

        val found = TermuxResultReceiver.resolveRequest(id, fakeResult("hit"))

        assertTrue(found)
        assertTrue(deferred.isCompleted)
        assertEquals("hit", deferred.getCompleted().stdout)
    }

    @Test
    fun `a stale or unknown request id is ignored, not crashing and not resolving anything`() {
        val found = TermuxResultReceiver.resolveRequest(999_999, fakeResult("nobody"))
        assertFalse(found)
    }

    @Test
    fun `unregistering before a callback arrives makes a later resolve for that id a no-op`() {
        val deferred = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val id = TermuxResultReceiver.register(deferred)
        TermuxResultReceiver.unregister(id)

        val found = TermuxResultReceiver.resolveRequest(id, fakeResult("late"))

        assertFalse(found)
        assertFalse(deferred.isCompleted)
    }

    @Test
    fun `two concurrent requests each resolve to their own result, even out of order`() {
        val deferredA = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val deferredB = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val idA = TermuxResultReceiver.register(deferredA)
        val idB = TermuxResultReceiver.register(deferredB)

        // Resolve B before A — order must not matter for correlation.
        TermuxResultReceiver.resolveRequest(idB, fakeResult("b-result"))
        TermuxResultReceiver.resolveRequest(idA, fakeResult("a-result"))

        assertEquals("a-result", deferredA.getCompleted().stdout)
        assertEquals("b-result", deferredB.getCompleted().stdout)
    }

    @Test
    fun `resolving one request id never touches an unrelated pending request`() {
        val deferredA = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val deferredB = kotlinx.coroutines.CompletableDeferred<TermuxCommandResult>()
        val idA = TermuxResultReceiver.register(deferredA)
        TermuxResultReceiver.register(deferredB)

        TermuxResultReceiver.resolveRequest(idA, fakeResult("only-a"))

        assertTrue(deferredA.isCompleted)
        assertFalse(deferredB.isCompleted)
    }
}
