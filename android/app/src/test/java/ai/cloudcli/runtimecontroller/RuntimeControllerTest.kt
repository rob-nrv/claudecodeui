package ai.cloudcli.runtimecontroller

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage of the one thing this app is trusted to get right: turning
 * an [AdapterOutcome] into the correct screen state, without itself deciding
 * what "online" means (that stays server-side). No Android framework classes
 * are touched here, so — unlike the rest of this module — it needs only a
 * Kotlin/JVM test runner, not the Android Gradle Plugin.
 *
 * NOT EXECUTED: this environment has no JDK/Gradle to run it. Written to the
 * same standard as the shipped backend tests it mirrors conceptually
 * (`runtime-start.test.ts`), for a future session with a real Android
 * toolchain to run and trust.
 */
class RuntimeControllerTest {

    private fun onlineStatus(instanceId: String = "instance-a") = RuntimeStatusInfo(
        state = "online",
        reason = "verified",
        ownedByMarker = true,
        instanceId = instanceId,
        url = "http://127.0.0.1:3001",
        pid = 4242,
    )

    private fun offlineStatus() = RuntimeStatusInfo(
        state = "stopped",
        reason = "no-runtime",
        ownedByMarker = false,
        instanceId = null,
        url = null,
        pid = null,
    )

    private class FakeAdapter(
        private val statusResult: AdapterOutcome<RuntimeStatusInfo>,
        private val startResult: AdapterOutcome<RuntimeStartResultInfo>? = null,
        private val stopResult: AdapterOutcome<RuntimeStopResultInfo>? = null,
        // Which onStep() calls a start() invocation makes, in order. Defaults to the
        // single-step shape the pre-existing tests below already assume.
        private val stepsToEmit: List<StartStep> = listOf(StartStep.RUNTIME_AVAILABLE),
    ) : RuntimeAdapter {
        var startSteps: MutableList<StartStep> = mutableListOf()

        // Re-entry-guard witnesses: RuntimeController.busy is expected to keep these
        // at exactly 1 per user-intended operation, however many times a button is
        // tapped while one is already in flight.
        var startCallCount = 0
        var stopCallCount = 0

        override suspend fun status() = statusResult
        override suspend fun start(onStep: (StartStep) -> Unit): AdapterOutcome<RuntimeStartResultInfo> {
            startCallCount += 1
            stepsToEmit.forEach { step ->
                onStep(step)
                startSteps.add(step)
            }
            return startResult!!
        }
        override suspend fun stop(): AdapterOutcome<RuntimeStopResultInfo> {
            stopCallCount += 1
            return stopResult!!
        }
        override fun webUrl(status: RuntimeStatusInfo?) = status?.url
    }

    @Test
    fun `refreshStatus renders Online for a verified running instance`() {
        val scope = TestScope(StandardTestDispatcher())
        val controller = RuntimeController(FakeAdapter(AdapterOutcome.Success(onlineStatus())), scope)

        controller.refreshStatus()
        scope.advanceUntilIdle()

        assertTrue(controller.state.value is RuntimeScreenState.Online)
    }

    @Test
    fun `refreshStatus renders Offline with no error when nothing is running`() {
        val scope = TestScope(StandardTestDispatcher())
        val controller = RuntimeController(FakeAdapter(AdapterOutcome.Success(offlineStatus())), scope)

        controller.refreshStatus()
        scope.advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state is RuntimeScreenState.Offline)
        assertEquals(null, (state as RuntimeScreenState.Offline).error)
    }

    @Test
    fun `a status adapter failure renders Offline carrying the failure message`() {
        val scope = TestScope(StandardTestDispatcher())
        val controller = RuntimeController(
            FakeAdapter(AdapterOutcome.Failure("Termux is not installed.", "package not found")),
            scope,
        )

        controller.refreshStatus()
        scope.advanceUntilIdle()

        val state = controller.state.value as RuntimeScreenState.Offline
        assertEquals("Termux is not installed.", state.error?.message)
    }

    @Test
    fun `start renders Online once the adapter reports a verified new instance`() {
        val scope = TestScope(StandardTestDispatcher())
        val startResult = RuntimeStartResultInfo(
            outcome = "started",
            newInstanceId = "instance-b",
            status = onlineStatus("instance-b"),
            launchError = null,
        )
        val controller = RuntimeController(
            FakeAdapter(AdapterOutcome.Success(offlineStatus()), startResult = AdapterOutcome.Success(startResult)),
            scope,
        )

        controller.start()
        scope.advanceUntilIdle()

        val state = controller.state.value
        assertTrue(state is RuntimeScreenState.Online)
        assertEquals("instance-b", (state as RuntimeScreenState.Online).status.instanceId)
    }

    @Test
    fun `a launch failure renders Error, never a false Online`() {
        val scope = TestScope(StandardTestDispatcher())
        val controller = RuntimeController(
            FakeAdapter(
                AdapterOutcome.Success(offlineStatus()),
                startResult = AdapterOutcome.Failure("CloudCLI failed to launch.", "not built"),
            ),
            scope,
        )

        controller.start()
        scope.advanceUntilIdle()

        assertTrue(controller.state.value is RuntimeScreenState.Error)
    }

    @Test
    fun `stop renders Offline on a successful stop`() {
        val scope = TestScope(StandardTestDispatcher())
        val stopResult = RuntimeStopResultInfo(outcome = "stopped", status = offlineStatus())
        val controller = RuntimeController(
            FakeAdapter(AdapterOutcome.Success(onlineStatus()), stopResult = AdapterOutcome.Success(stopResult)),
            scope,
        )

        controller.stop()
        scope.advanceUntilIdle()

        assertTrue(controller.state.value is RuntimeScreenState.Offline)
    }

    // ---- re-entry guard: START ----

    @Test
    fun `start dispatches exactly once even when tapped twice before it settles`() {
        val scope = TestScope(StandardTestDispatcher())
        val startResult = RuntimeStartResultInfo("started", "instance-b", onlineStatus("instance-b"), null)
        val adapter = FakeAdapter(AdapterOutcome.Success(offlineStatus()), startResult = AdapterOutcome.Success(startResult))
        val controller = RuntimeController(adapter, scope)

        controller.start()
        controller.start() // second tap arrives before the first has a chance to run
        scope.advanceUntilIdle()

        assertEquals(1, adapter.startCallCount)
        assertTrue(controller.state.value is RuntimeScreenState.Online)
    }

    @Test
    fun `start refuses a conflicting stop while it is busy`() {
        val scope = TestScope(StandardTestDispatcher())
        val startResult = RuntimeStartResultInfo("started", "instance-b", onlineStatus("instance-b"), null)
        val adapter = FakeAdapter(
            AdapterOutcome.Success(offlineStatus()),
            startResult = AdapterOutcome.Success(startResult),
            stopResult = AdapterOutcome.Success(RuntimeStopResultInfo("stopped", offlineStatus())),
        )
        val controller = RuntimeController(adapter, scope)

        controller.start()
        controller.stop() // conflicting action while START is in flight
        scope.advanceUntilIdle()

        assertEquals(0, adapter.stopCallCount)
        assertTrue(controller.state.value is RuntimeScreenState.Online)
    }

    @Test
    fun `start renders the fully completed checklist before flipping to Online, never skipping it`() {
        val scope = TestScope(StandardTestDispatcher())
        val startResult = RuntimeStartResultInfo("started", "instance-b", onlineStatus("instance-b"), null)
        val adapter = FakeAdapter(
            AdapterOutcome.Success(offlineStatus()),
            startResult = AdapterOutcome.Success(startResult),
            stepsToEmit = listOf(
                StartStep.RUNTIME_AVAILABLE,
                StartStep.LINUX_ENVIRONMENT,
                StartStep.CLOUDCLI_SERVER,
                StartStep.HEALTH_CHECK,
            ),
        )
        val controller = RuntimeController(adapter, scope)
        val collected = mutableListOf<RuntimeScreenState>()
        val collectorJob = scope.launch { controller.state.toList(collected) }

        controller.start()
        scope.advanceUntilIdle()
        collectorJob.cancel()

        val allSteps = setOf(
            StartStep.RUNTIME_AVAILABLE,
            StartStep.LINUX_ENVIRONMENT,
            StartStep.CLOUDCLI_SERVER,
            StartStep.HEALTH_CHECK,
        )
        val fullyCheckedIndex = collected.indexOfLast {
            it is RuntimeScreenState.Starting && it.completedSteps == allSteps
        }
        assertTrue("the fully-checked STARTING state must actually be rendered, not coalesced away", fullyCheckedIndex >= 0)
        val onlineIndex = collected.indexOfLast { it is RuntimeScreenState.Online }
        assertTrue(fullyCheckedIndex < onlineIndex)
    }

    @Test
    fun `a failed start clears busy and allows a retry to dispatch again`() {
        val scope = TestScope(StandardTestDispatcher())
        val adapter = FakeAdapter(
            AdapterOutcome.Success(offlineStatus()),
            startResult = AdapterOutcome.Failure("CloudCLI failed to launch.", "not built"),
        )
        val controller = RuntimeController(adapter, scope)

        controller.start()
        scope.advanceUntilIdle()
        assertTrue(controller.state.value is RuntimeScreenState.Error)

        controller.start() // recovery after failure must be allowed to dispatch again
        scope.advanceUntilIdle()

        assertEquals(2, adapter.startCallCount)
    }

    // ---- re-entry guard: STOP ----

    @Test
    fun `stop enters Stopping immediately, before the adapter call has run`() {
        val scope = TestScope(StandardTestDispatcher())
        val adapter = FakeAdapter(
            AdapterOutcome.Success(onlineStatus()),
            stopResult = AdapterOutcome.Success(RuntimeStopResultInfo("stopped", offlineStatus())),
        )
        val controller = RuntimeController(adapter, scope)
        controller.refreshStatus()
        scope.advanceUntilIdle()

        controller.stop()

        assertTrue(controller.state.value is RuntimeScreenState.Stopping)
        assertEquals(0, adapter.stopCallCount)
    }

    @Test
    fun `stop dispatches exactly once even when tapped twice before it settles`() {
        val scope = TestScope(StandardTestDispatcher())
        val adapter = FakeAdapter(
            AdapterOutcome.Success(onlineStatus()),
            stopResult = AdapterOutcome.Success(RuntimeStopResultInfo("stopped", offlineStatus())),
        )
        val controller = RuntimeController(adapter, scope)

        controller.stop()
        controller.stop() // second tap arrives before the first has a chance to run
        scope.advanceUntilIdle()

        assertEquals(1, adapter.stopCallCount)
        assertTrue(controller.state.value is RuntimeScreenState.Offline)
    }

    @Test
    fun `stop refuses a conflicting start while it is busy`() {
        val scope = TestScope(StandardTestDispatcher())
        val startResult = RuntimeStartResultInfo("started", "instance-b", onlineStatus("instance-b"), null)
        val adapter = FakeAdapter(
            AdapterOutcome.Success(onlineStatus()),
            startResult = AdapterOutcome.Success(startResult),
            stopResult = AdapterOutcome.Success(RuntimeStopResultInfo("stopped", offlineStatus())),
        )
        val controller = RuntimeController(adapter, scope)

        controller.stop()
        controller.start() // conflicting action while STOP is in flight
        scope.advanceUntilIdle()

        assertEquals(0, adapter.startCallCount)
        assertTrue(controller.state.value is RuntimeScreenState.Offline)
    }

    @Test
    fun `a failed stop surfaces the error and clears busy so a retry can dispatch again`() {
        val scope = TestScope(StandardTestDispatcher())
        val adapter = FakeAdapter(
            AdapterOutcome.Success(onlineStatus()),
            stopResult = AdapterOutcome.Failure("CloudCLI didn't stop in time.", "timeout"),
        )
        val controller = RuntimeController(adapter, scope)

        controller.stop()
        scope.advanceUntilIdle()
        assertTrue(controller.state.value is RuntimeScreenState.Error)

        controller.stop() // recovery after failure must be allowed to dispatch again
        scope.advanceUntilIdle()

        assertEquals(2, adapter.stopCallCount)
    }
}
