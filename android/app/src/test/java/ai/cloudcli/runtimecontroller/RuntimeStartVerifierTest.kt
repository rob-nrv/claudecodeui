package ai.cloudcli.runtimecontroller

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for [RuntimeStartVerifier] — the state machine that
 * replaced routing Android START through `cloudcli runtime start`. No sleeps:
 * [wait] just advances a fake clock, so a 90s timeout test runs instantly.
 *
 * This is what stands in for the device proof in C2-P1-L02-D01: it exercises
 * exactly the case that diagnosis showed the backend's own confirmStableOnline
 * structurally could not see — a server that answers ONLINE once and is gone
 * on the very next observation (see the "goes online then disappears" test
 * below).
 */
class RuntimeStartVerifierTest {

    private fun online(instanceId: String = "instance-a", ownedByMarker: Boolean = true, reason: String = "verified") =
        RuntimeStatusInfo(
            state = "online",
            reason = reason,
            ownedByMarker = ownedByMarker,
            instanceId = instanceId,
            url = "http://127.0.0.1:3001",
            pid = 4242,
        )

    private fun stopped() = RuntimeStatusInfo(
        state = "stopped",
        reason = "no-runtime",
        ownedByMarker = false,
        instanceId = null,
        url = null,
        pid = null,
    )

    private fun starting() = RuntimeStatusInfo(
        state = "starting",
        reason = "awaiting-health",
        ownedByMarker = false,
        instanceId = null,
        url = null,
        pid = null,
    )

    private fun instanceMismatch() = RuntimeStatusInfo(
        state = "error",
        reason = "instance-mismatch",
        ownedByMarker = false,
        instanceId = "someone-else",
        url = null,
        pid = 99,
    )

    /** Backend verified as ours, but with no client build to serve — never a launch target. */
    private fun appNotReady() = RuntimeStatusInfo(
        state = "error",
        reason = "app-not-ready",
        ownedByMarker = true,
        instanceId = "instance-a",
        url = "http://127.0.0.1:3001",
        pid = 4242,
    )

    /** A monotonic clock [wait] advances directly, so no test here really sleeps. */
    private class FakeClock {
        var nowMs: Long = 0
        val elapsed: () -> Long = { nowMs }
        val wait: suspend (Long) -> Unit = { ms -> nowMs += ms }
    }

    private class FakeDispatcher(private val failure: AdapterOutcome.Failure? = null) {
        var callCount = 0
        val dispatch: suspend () -> AdapterOutcome.Failure? = {
            callCount += 1
            failure
        }
    }

    /**
     * Stands in for "has the dispatched launch command exited yet, and how".
     * [exitAfter] is how many probes report "still running" before the exit is
     * visible — real launches die a moment after dispatch, not during it.
     */
    private class FakeLaunch(private val exit: RuntimeStartVerifier.LaunchExit?, private val exitAfter: Int = 0) {
        var probeCount = 0
        val probe: () -> RuntimeStartVerifier.LaunchExit? = {
            val visible = probeCount >= exitAfter
            probeCount += 1
            if (visible) exit else null
        }
    }

    private class FakeStatusSequence(private val results: List<AdapterOutcome<RuntimeStatusInfo>>) {
        var callCount = 0
        val poll: suspend () -> AdapterOutcome<RuntimeStatusInfo> = {
            val index = callCount.coerceAtMost(results.size - 1)
            callCount += 1
            results[index]
        }
    }

    private fun steps(): MutableList<StartStep> = mutableListOf()

    @Test
    fun `already-online status is idempotent and never dispatches`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val onSteps = steps()

        val result = RuntimeStartVerifier.start(
            preflightStatus = online(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = { error("status should never be polled when already online") },
            wait = clock.wait,
            onStep = onSteps::add,
            elapsedMs = clock.elapsed,
        )

        assertEquals(0, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Success)
        assertEquals("already-running", (result as AdapterOutcome.Success).value.outcome)
    }

    @Test
    fun `foreign or unowned instance is refused without dispatching or killing anything`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()

        val result = RuntimeStartVerifier.start(
            preflightStatus = online(ownedByMarker = false, reason = "foreign-instance"),
            dispatchServer = dispatcher.dispatch,
            pollStatus = { error("status should never be polled when refusing to start") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(0, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Failure)
    }

    @Test
    fun `instance-mismatch is refused without dispatching`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()

        val result = RuntimeStartVerifier.start(
            preflightStatus = instanceMismatch(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = { error("status should never be polled when refusing to start") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(0, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Failure)
    }

    @Test
    fun `app-not-ready is refused without dispatching a second server on top of it`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()

        val result = RuntimeStartVerifier.start(
            preflightStatus = appNotReady(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = { error("status should never be polled when refusing to start") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(0, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Failure)
        assertTrue((result as AdapterOutcome.Failure).userMessage.contains("hasn't been built"))
    }

    @Test
    fun `app-not-ready appearing while waiting for our own launch fails fast, never claims online`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val statuses = FakeStatusSequence(listOf(AdapterOutcome.Success(appNotReady())))

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(1, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Failure)
        assertTrue((result as AdapterOutcome.Failure).userMessage.contains("hasn't been built"))
        // Fails immediately instead of burning the whole 90s timeout.
        assertTrue(clock.nowMs < RuntimeStartVerifier.Policy().serverOnlineTimeoutMs)
    }

    @Test
    fun `genuinely stopped dispatches the long-running server exactly once`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val instanceId = "instance-b"
        val statuses = FakeStatusSequence(
            List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                AdapterOutcome.Success(online(instanceId))
            },
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(1, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Success)
        assertEquals(instanceId, (result as AdapterOutcome.Success).value.newInstanceId)
    }

    @Test
    fun `an already in-flight start is observed, never dispatched a second time`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val instanceId = "instance-c"
        val statuses = FakeStatusSequence(
            List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                AdapterOutcome.Success(online(instanceId))
            },
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = starting(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(0, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Success)
    }

    @Test
    fun `dispatch failure is surfaced without ever polling status`() = runTest {
        val clock = FakeClock()
        val failure = AdapterOutcome.Failure("Termux couldn't run that command.", "boom")
        val dispatcher = FakeDispatcher(failure)

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = { error("must not poll after a failed dispatch") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertEquals(1, dispatcher.callCount)
        assertEquals(failure, result)
    }

    @Test
    fun `never becoming online times out as a bounded failure, not an infinite loop`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val policy = RuntimeStartVerifier.Policy(serverOnlineTimeoutMs = 10_000, statusPollIntervalMs = 2_000)
        val statuses = FakeStatusSequence(List(20) { AdapterOutcome.Success(starting()) })

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            policy = policy,
        )

        assertTrue(result is AdapterOutcome.Failure)
        assertTrue(clock.nowMs >= policy.serverOnlineTimeoutMs)
    }

    @Test
    fun `a server that goes online then disappears never reports success`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val statuses = FakeStatusSequence(
            listOf(
                AdapterOutcome.Success(online("instance-d")), // first ONLINE
                AdapterOutcome.Success(stopped()), // gone on the very next external observation
            ),
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertTrue(result is AdapterOutcome.Failure)
        assertEquals(2, statuses.callCount)
    }

    @Test
    fun `an instance id change during confirmation never reports success`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val statuses = FakeStatusSequence(
            listOf(
                AdapterOutcome.Success(online("instance-e")),
                AdapterOutcome.Success(online("instance-f")), // different identity mid-confirmation
            ),
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertTrue(result is AdapterOutcome.Failure)
    }

    @Test
    fun `a foreign instance appearing while waiting for our own launch is refused, not adopted`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val statuses = FakeStatusSequence(listOf(AdapterOutcome.Success(instanceMismatch())))

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
        )

        assertTrue(result is AdapterOutcome.Failure)
    }

    @Test
    fun `HEALTH_CHECK is only reported once stability confirmations pass, never on the first reading alone`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val instanceId = "instance-g"
        val statuses = FakeStatusSequence(
            List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                AdapterOutcome.Success(online(instanceId))
            },
        )
        val onSteps = steps()

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = onSteps::add,
            elapsedMs = clock.elapsed,
        )

        assertTrue(result is AdapterOutcome.Success)
        assertTrue(onSteps.contains(StartStep.LINUX_ENVIRONMENT))
        assertTrue(onSteps.contains(StartStep.HEALTH_CHECK))
        // Reported only after the first ONLINE reading plus every confirmation poll.
        assertEquals(RuntimeStartVerifier.Policy().stabilityConfirmations + 1, statuses.callCount)
    }

    // ---- launch-exit observation: a dispatch is not a running server ----
    //
    // C2-R1-L01. Before these, START had exactly one way to end badly: wait the
    // full 90s and say "CloudCLI started but never became healthy" — a claim it
    // had no evidence for, and which was flatly wrong in the field case that
    // prompted this (the launch died on its first line and no process ever
    // existed).

    @Test
    fun `a launch that exits before coming online reports that exit, not a health timeout`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val policy = RuntimeStartVerifier.Policy(serverOnlineTimeoutMs = 90_000, statusPollIntervalMs = 2_000)
        val launch = FakeLaunch(
            RuntimeStartVerifier.LaunchExit(exitCode = 1, stderr = "Error: ERR_DLOPEN_FAILED", executionError = null),
            exitAfter = 1,
        )
        val statuses = FakeStatusSequence(List(60) { AdapterOutcome.Success(stopped()) })

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = launch.probe,
            policy = policy,
        )

        assertTrue(result is AdapterOutcome.Failure)
        val failure = result as AdapterOutcome.Failure
        // Never claims CloudCLI started: no process was ever observed running.
        assertFalse(failure.userMessage.contains("started"))
        assertTrue(failure.details.contains("exited 1"))
        assertTrue(failure.details.contains("ERR_DLOPEN_FAILED"))
        // And it says so immediately, instead of burning the whole timeout first.
        assertTrue(clock.nowMs < policy.serverOnlineTimeoutMs)
    }

    @Test
    fun `Termux failing to run the launch at all is reported as that, not as the server dying`() = runTest {
        val clock = FakeClock()
        val launch = FakeLaunch(
            RuntimeStartVerifier.LaunchExit(exitCode = null, stderr = "", executionError = "Executable not found."),
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = FakeDispatcher().dispatch,
            pollStatus = { error("status must not be polled once the launch is known dead") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = launch.probe,
        )

        assertTrue(result is AdapterOutcome.Failure)
        assertEquals("Termux couldn't run the CloudCLI server.", (result as AdapterOutcome.Failure).userMessage)
        assertTrue(result.details.contains("Executable not found."))
    }

    @Test
    fun `launch stderr quoted back into the failure is bounded`() = runTest {
        val clock = FakeClock()
        val noisy = "x".repeat(50_000)
        val launch = FakeLaunch(RuntimeStartVerifier.LaunchExit(exitCode = 127, stderr = noisy, executionError = null))

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = FakeDispatcher().dispatch,
            pollStatus = { error("status must not be polled once the launch is known dead") },
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = launch.probe,
        )

        assertTrue(result is AdapterOutcome.Failure)
        assertTrue((result as AdapterOutcome.Failure).details.length < 1_000)
    }

    @Test
    fun `a launch exit is never attributed to a start we did not dispatch`() = runTest {
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        // An in-flight start is adopted, so nothing of ours was launched — a
        // stale exit result must not be able to fail somebody else's start.
        val launch = FakeLaunch(
            RuntimeStartVerifier.LaunchExit(exitCode = 1, stderr = "stale", executionError = null),
        )
        val statuses = FakeStatusSequence(
            List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                AdapterOutcome.Success(online("instance-h"))
            },
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = starting(),
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = launch.probe,
        )

        assertEquals(0, dispatcher.callCount)
        assertEquals(0, launch.probeCount)
        assertTrue(result is AdapterOutcome.Success)
    }

    @Test
    fun `a live launch that simply has not finished booting still gets the full online wait`() = runTest {
        val clock = FakeClock()
        val instanceId = "instance-i"
        // probe always says "still running" — the normal case for a healthy server.
        val launch = FakeLaunch(exit = null)
        val statuses = FakeStatusSequence(
            listOf(AdapterOutcome.Success(stopped()), AdapterOutcome.Success(starting())) +
                List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                    AdapterOutcome.Success(online(instanceId))
                },
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(),
            dispatchServer = FakeDispatcher().dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = launch.probe,
        )

        assertTrue(result is AdapterOutcome.Success)
        assertEquals(instanceId, (result as AdapterOutcome.Success).value.newInstanceId)
    }

    @Test
    fun `START after a STOP dispatches a fresh launch and accepts the new instance id`() = runTest {
        // The reported field sequence: ONLINE -> STOP -> OFFLINE -> START again.
        // Nothing about the previous instance may leak into the second start —
        // it must dispatch again and confirm whatever new identity comes up.
        val clock = FakeClock()
        val dispatcher = FakeDispatcher()
        val secondInstance = "instance-after-stop"
        val statuses = FakeStatusSequence(
            listOf(AdapterOutcome.Success(stopped())) +
                List(RuntimeStartVerifier.Policy().stabilityConfirmations + 1) {
                    AdapterOutcome.Success(online(secondInstance))
                },
        )

        val result = RuntimeStartVerifier.start(
            preflightStatus = stopped(), // exactly what a completed STOP leaves behind
            dispatchServer = dispatcher.dispatch,
            pollStatus = statuses.poll,
            wait = clock.wait,
            onStep = {},
            elapsedMs = clock.elapsed,
            launchExit = FakeLaunch(exit = null).probe,
        )

        assertEquals(1, dispatcher.callCount)
        assertTrue(result is AdapterOutcome.Success)
        assertEquals(secondInstance, (result as AdapterOutcome.Success).value.newInstanceId)
    }
}
