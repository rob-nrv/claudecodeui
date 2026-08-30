package ai.cloudcli.runtimecontroller

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * V0's only [RuntimeAdapter]: reaches the CloudCLI runtime by asking Termux to
 * run the already-verified `cloudcli runtime <verb> --json` CLI inside the
 * user's proot-distro Linux environment, via Termux's documented RUN_COMMAND
 * intent (`com.termux.RUN_COMMAND` → `com.termux.app.RunCommandService`,
 * https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent). It never
 * parses process lists, marker files, or port state itself — the backend's
 * own resolver (`resolveRuntimeStatus`) is the only source of truth for what
 * "online" means, exactly as instructed by `runtime-probe.ts`'s own comment
 * that an Android controller "reuses the exact same logic".
 *
 * One exception, and it is cosmetic only: while a `start` is in flight, this
 * adapter also polls `http://127.0.0.1:<port>/health` directly every few
 * seconds — loopback is shared between Termux/proot and the rest of the
 * device, so this is reachable without going through Termux at all. That poll
 * only advances the STARTING screen's checklist earlier; the actual
 * started/failed verdict comes from repeated `cloudcli runtime status --json`
 * calls, verified by [RuntimeStartVerifier].
 *
 * START does NOT run `cloudcli runtime start` — see
 * [dispatchLongRunningServer] and [TermuxCommandBuilder.buildServerLaunchCommand]
 * for why (device-diagnosed: C2-P1-L02-D01). It dispatches the server itself
 * as a long-running, untracked RUN_COMMAND, then proves success with separate
 * short `status` RUN_COMMANDs — the same tracked round trip [status] and
 * [stop] already use.
 */
class TermuxRuntimeAdapter(
    private val context: Context,
    private val config: RuntimeConfig,
) : RuntimeAdapter {

    override suspend fun status(): AdapterOutcome<RuntimeStatusInfo> {
        preflight<RuntimeStatusInfo>()?.let { return it }

        return when (val result = runRuntimeCommand("status", STATUS_TIMEOUT_MS)) {
            is CommandOutcome.Dispatched -> parseJson(result.result, "status") { json ->
                RuntimeStatusInfo.fromJson(json)
            }
            is CommandOutcome.NotDispatched -> result.failure
        }
    }

    override suspend fun start(onStep: (StartStep) -> Unit): AdapterOutcome<RuntimeStartResultInfo> {
        preflight<RuntimeStartResultInfo>()?.let { return it }
        onStep(StartStep.RUNTIME_AVAILABLE)

        return coroutineScope {
            val initialStatus = when (val outcome = pollStatusOnce()) {
                is AdapterOutcome.Success -> outcome.value
                is AdapterOutcome.Failure -> return@coroutineScope outcome
            }

            val cosmeticPoll: Job = launch { pollHealthUntilCancelled { onStep(StartStep.CLOUDCLI_SERVER) } }
            val result = RuntimeStartVerifier.start(
                preflightStatus = initialStatus,
                dispatchServer = { dispatchLongRunningServer() },
                pollStatus = { pollStatusOnce() },
                wait = { milliseconds -> delay(milliseconds) },
                onStep = onStep,
                elapsedMs = { System.currentTimeMillis() },
            )
            cosmeticPoll.cancel()
            result
        }
    }

    override suspend fun stop(): AdapterOutcome<RuntimeStopResultInfo> {
        preflight<RuntimeStopResultInfo>()?.let { return it }

        return when (val result = runRuntimeCommand("stop", STOP_TIMEOUT_MS)) {
            is CommandOutcome.Dispatched -> parseJson(result.result, "stop") { json ->
                RuntimeStopResultInfo.fromJson(json)
            }
            is CommandOutcome.NotDispatched -> result.failure
        }
    }

    override fun webUrl(status: RuntimeStatusInfo?): String? =
        status?.url ?: "http://127.0.0.1:${config.serverPort}"

    // ---- shared plumbing ----

    private fun <T> preflight(): AdapterOutcome<T>? {
        if (!config.isTermuxInstalled()) {
            return AdapterOutcome.Failure(
                userMessage = "Termux is not installed.",
                details = "Package ${RuntimeConfig.TERMUX_PACKAGE} was not found via PackageManager.",
            )
        }
        if (!config.isConfigured) {
            return AdapterOutcome.Failure(
                userMessage = "CloudCLI location isn't set up yet.",
                details = "Open Settings and set the distro, Linux user, and CloudCLI checkout path.",
            )
        }
        return null
    }

    private sealed class CommandOutcome {
        data class Dispatched(val result: TermuxCommandResult) : CommandOutcome()
        data class NotDispatched(val failure: AdapterOutcome.Failure) : CommandOutcome()
    }

    private suspend fun runRuntimeCommand(verb: String, timeoutMs: Long): CommandOutcome {
        val deferred = CompletableDeferred<TermuxCommandResult>()
        val requestId = TermuxResultReceiver.register(deferred)

        val failure = dispatch<Nothing>(commandPathAndArgs(verb), requestId)
        if (failure != null) {
            TermuxResultReceiver.unregister(requestId)
            return CommandOutcome.NotDispatched(failure as AdapterOutcome.Failure)
        }

        val result = withTimeoutOrNull(timeoutMs + DISPATCH_MARGIN_MS) { deferred.await() }
        TermuxResultReceiver.unregister(requestId)

        return if (result == null) {
            CommandOutcome.NotDispatched(
                AdapterOutcome.Failure(
                    userMessage = "Termux didn't respond in time.",
                    details = "No RUN_COMMAND result within ${(timeoutMs + DISPATCH_MARGIN_MS) / 1000}s.",
                ),
            )
        } else {
            CommandOutcome.Dispatched(result)
        }
    }

    /** Sends the RUN_COMMAND intent. Returns a Failure if it could not even be dispatched. */
    private fun <T> dispatch(pathAndArgs: Pair<String, Array<String>>, requestId: Int): AdapterOutcome<T>? {
        val (path, arguments) = pathAndArgs
        val resultIntent = Intent(context, TermuxResultReceiver::class.java)
            .putExtra(TermuxResultReceiver.requestIdExtraKey(), requestId)
        // Termux needs to fill result extras into this PendingIntent, which requires
        // mutability from Android 12 (API 31) onward; the flag doesn't exist before that.
        val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            requestId,
            resultIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag,
        )
        return startTermuxService(buildRunCommandIntent(path, arguments, pendingIntent))
    }

    /**
     * Fires the server itself as a long-running RUN_COMMAND — never awaited,
     * never registered with [TermuxResultReceiver]. This command's own result
     * would only arrive when the server process eventually exits (at STOP, or
     * on crash), and holding a [CompletableDeferred]/request id registered
     * until then — for the runtime's entire lifetime — is exactly the leak
     * this must avoid.
     *
     * Per RUN_COMMAND's contract, `RUN_COMMAND_PENDING_INTENT` is optional:
     * omitting it means Termux runs the command and simply never calls back,
     * which is the fire-and-forget this needs. Whether the *launch* worked is
     * proven separately, from outside this command entirely, by polling
     * `status` afterward ([RuntimeStartVerifier]) — this call only proves the
     * intent reached `RunCommandService`.
     *
     * The server becomes this RUN_COMMAND's own main tracee (see
     * [TermuxCommandBuilder.buildServerLaunchCommand]), so proot's
     * `--kill-on-exit` has nothing to kill until the server itself exits.
     */
    private fun dispatchLongRunningServer(): AdapterOutcome.Failure? {
        val path = "${RuntimeConfig.TERMUX_PREFIX}/bin/proot-distro"
        val arguments = arrayOf(
            "login", config.distro,
            "--user", config.prootUsername,
            "--", "bash", "-lc", TermuxCommandBuilder.buildServerLaunchCommand(config.repoPath),
        )
        return startTermuxService(buildRunCommandIntent(path, arguments, pendingIntent = null))
    }

    private fun buildRunCommandIntent(path: String, arguments: Array<String>, pendingIntent: PendingIntent?): Intent {
        val intent = Intent()
            .setClassName(RuntimeConfig.TERMUX_PACKAGE, "com.termux.app.RunCommandService")
            .setAction("com.termux.RUN_COMMAND")
            .putExtra("com.termux.RUN_COMMAND_PATH", path)
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments)
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", RuntimeConfig.TERMUX_HOME)
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        if (pendingIntent != null) {
            intent.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pendingIntent)
        }
        return intent
    }

    private fun startTermuxService(commandIntent: Intent): AdapterOutcome.Failure? = try {
        context.startService(commandIntent)
        null
    } catch (error: SecurityException) {
        AdapterOutcome.Failure(
            userMessage = "CloudCLI Runtime needs permission to run commands in Termux.",
            details = "RUN_COMMAND permission was not granted: ${error.message}",
        )
    } catch (error: IllegalStateException) {
        // Android 8+ background-start restriction: the app must be foreground to start
        // this service, which holds for the case that matters — the user just tapped Start.
        AdapterOutcome.Failure(
            userMessage = "Couldn't reach Termux right now.",
            details = "startService failed: ${error.message}",
        )
    }

    private fun commandPathAndArgs(verb: String): Pair<String, Array<String>> {
        val path = "${RuntimeConfig.TERMUX_PREFIX}/bin/proot-distro"
        val innerCommand = TermuxCommandBuilder.buildInnerCommand(config.repoPath, verb)
        val arguments = arrayOf(
            "login", config.distro,
            "--user", config.prootUsername,
            "--", "bash", "-lc", innerCommand,
        )
        return path to arguments
    }

    private suspend fun pollStatusOnce(): AdapterOutcome<RuntimeStatusInfo> =
        when (val result = runRuntimeCommand("status", STATUS_TIMEOUT_MS)) {
            is CommandOutcome.Dispatched -> parseJson(result.result, "status") { json -> RuntimeStatusInfo.fromJson(json) }
            is CommandOutcome.NotDispatched -> result.failure
        }

    private fun <T> parseJson(result: TermuxCommandResult, verb: String, parse: (JSONObject) -> T): AdapterOutcome<T> =
        TermuxResultOutcome.from(result, verb, parse)

    /** Cosmetic only — never decides success/failure, only nudges the checklist along. */
    private suspend fun pollHealthUntilCancelled(onFirstResponse: () -> Unit) {
        var seen = false
        while (coroutineContext.isActive) {
            if (!seen && isHealthReachable()) {
                seen = true
                onFirstResponse()
            }
            delay(HEALTH_POLL_INTERVAL_MS)
        }
    }

    private fun isHealthReachable(): Boolean {
        return try {
            val connection = URL("http://127.0.0.1:${config.serverPort}/health").openConnection() as HttpURLConnection
            connection.connectTimeout = HEALTH_POLL_TIMEOUT_MS.toInt()
            connection.readTimeout = HEALTH_POLL_TIMEOUT_MS.toInt()
            connection.requestMethod = "GET"
            val ok = connection.responseCode in 200..299
            connection.disconnect()
            ok
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        private const val STATUS_TIMEOUT_MS = 15_000L
        private const val STOP_TIMEOUT_MS = 20_000L
        private const val DISPATCH_MARGIN_MS = 5_000L
        private const val HEALTH_POLL_INTERVAL_MS = 2_000L
        private const val HEALTH_POLL_TIMEOUT_MS = 1_000L
    }
}
