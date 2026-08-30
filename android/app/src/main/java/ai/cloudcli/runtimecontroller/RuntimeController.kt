package ai.cloudcli.runtimecontroller

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield

data class FailureInfo(val message: String, val details: String)

/** What the single Runtime screen renders. Mirrors the mission's four-state mock exactly. */
sealed class RuntimeScreenState {
    object Checking : RuntimeScreenState()
    data class Offline(val error: FailureInfo? = null) : RuntimeScreenState()
    data class Starting(val completedSteps: Set<StartStep>) : RuntimeScreenState()
    object Stopping : RuntimeScreenState()
    data class Online(val status: RuntimeStatusInfo) : RuntimeScreenState()
    data class Error(val error: FailureInfo) : RuntimeScreenState()
}

/**
 * Platform-neutral: everything here is `RuntimeAdapter`-shaped, so swapping
 * [TermuxRuntimeAdapter] for a future native/Linux/desktop adapter changes
 * zero lines in this file. This is the one place that turns adapter results
 * into the screen state — it does not itself decide what "online" means,
 * that is entirely the backend's `resolveRuntimeStatus` via the adapter.
 */
class RuntimeController(
    private val adapter: RuntimeAdapter,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<RuntimeScreenState>(RuntimeScreenState.Checking)
    val state: StateFlow<RuntimeScreenState> = _state.asStateFlow()

    private var busy = false

    fun refreshStatus() {
        if (busy) return
        scope.launch {
            when (val outcome = adapter.status()) {
                is AdapterOutcome.Success -> _state.value = screenStateFor(outcome.value)
                is AdapterOutcome.Failure -> _state.value =
                    RuntimeScreenState.Offline(FailureInfo(outcome.userMessage, outcome.details))
            }
        }
    }

    /**
     * One runtime operation at a time. [busy] is the actual re-entry guard —
     * checked and set synchronously, before any suspension point — not a UI
     * affordance. Every entry point (button taps, [onResume]'s [refreshStatus])
     * only ever runs on the main thread, so this check-then-set is race-free
     * without needing a lock: nothing else can run between the read and the
     * write. A button being visually disabled is a second, cosmetic layer on
     * top of this, never the only thing standing between a tap and a dispatch.
     */
    fun start() {
        if (busy) return
        busy = true
        _state.value = RuntimeScreenState.Starting(emptySet())

        scope.launch {
            val steps = mutableSetOf<StartStep>()
            val outcome = adapter.start { step ->
                steps.add(step)
                _state.value = RuntimeScreenState.Starting(steps.toSet())
            }
            if (outcome is AdapterOutcome.Success) {
                // The last checklist step and the ONLINE state would otherwise be set
                // back-to-back with no suspension in between, so a collector reading
                // this flow could coalesce them and never render the fully-checked
                // list. yield() hands control back to the dispatcher for one pass —
                // a real render opportunity, not an arbitrary delay — so the finished
                // checklist is guaranteed at least one frame before ONLINE replaces it.
                yield()
            }
            busy = false

            _state.value = when (outcome) {
                is AdapterOutcome.Success -> screenStateFor(outcome.value.status)
                is AdapterOutcome.Failure ->
                    RuntimeScreenState.Error(FailureInfo(outcome.userMessage, outcome.details))
            }
        }
    }

    fun stop() {
        if (busy) return
        busy = true
        _state.value = RuntimeScreenState.Stopping

        scope.launch {
            val outcome = adapter.stop()
            busy = false
            _state.value = when (outcome) {
                is AdapterOutcome.Success -> screenStateFor(outcome.value.status)
                is AdapterOutcome.Failure ->
                    RuntimeScreenState.Error(FailureInfo(outcome.userMessage, outcome.details))
            }
        }
    }

    fun webUrl(): String? {
        val current = _state.value
        val status = (current as? RuntimeScreenState.Online)?.status
        return adapter.webUrl(status)
    }

    private fun screenStateFor(status: RuntimeStatusInfo): RuntimeScreenState = when (status.state) {
        "online" -> RuntimeScreenState.Online(status)
        "starting" -> RuntimeScreenState.Starting(
            setOf(StartStep.RUNTIME_AVAILABLE, StartStep.LINUX_ENVIRONMENT, StartStep.CLOUDCLI_SERVER),
        )
        "error" -> RuntimeScreenState.Error(FailureInfo(humanReason(status.reason), status.reason))
        else -> RuntimeScreenState.Offline() // "stopped" / "stopping"
    }

    private fun humanReason(reason: String): String = when (reason) {
        "instance-mismatch" -> "A different, unrecognised process is using CloudCLI's port."
        "health-timeout" -> "CloudCLI's process is running but never became healthy."
        "start-timeout" -> "CloudCLI didn't come up in time."
        "stop-timeout" -> "CloudCLI didn't stop in time."
        else -> "CloudCLI reported a problem."
    }
}
