package ai.cloudcli.runtimecontroller

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
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
}
