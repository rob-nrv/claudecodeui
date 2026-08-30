package ai.cloudcli.runtimecontroller

/**
 * What a runtime controller needs from a platform-specific bridge. V0 has one
 * implementation ([TermuxRuntimeAdapter]); a future [AndroidNativeRuntimeAdapter]
 * or `LinuxRuntimeAdapter`/`DesktopRuntimeAdapter` would implement the same
 * contract without [RuntimeController] or the UI changing at all.
 *
 * Every method returns the backend's own verdict (`cloudcli runtime <verb>
 * --json`, parsed verbatim) or a [Failure] describing why the bridge itself
 * could not reach that verdict (Termux missing, permission not granted, no
 * response). It never invents a status by inspecting processes itself.
 */
interface RuntimeAdapter {
    suspend fun status(): AdapterOutcome<RuntimeStatusInfo>

    suspend fun start(onStep: (StartStep) -> Unit = {}): AdapterOutcome<RuntimeStartResultInfo>

    suspend fun stop(): AdapterOutcome<RuntimeStopResultInfo>

    /** The address a human should open once the runtime is online, or null if unknown. */
    fun webUrl(status: RuntimeStatusInfo?): String?
}

/** The four checklist rows on the STARTING screen, in order. */
enum class StartStep {
    RUNTIME_AVAILABLE, // Termux is installed and reachable
    LINUX_ENVIRONMENT, // proot-distro session reached the target user's shell
    CLOUDCLI_SERVER, // the launch command was accepted server-side
    HEALTH_CHECK, // /health answered and identity was confirmed
}

sealed class AdapterOutcome<out T> {
    data class Success<T>(val value: T) : AdapterOutcome<T>()

    /**
     * [userMessage] is the one sentence the OFFLINE/ERROR screen shows.
     * [details] is everything else (raw stderr, exit codes) behind "Details".
     */
    data class Failure(val userMessage: String, val details: String) : AdapterOutcome<Nothing>()
}
