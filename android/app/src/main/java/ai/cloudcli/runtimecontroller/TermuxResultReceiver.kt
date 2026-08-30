package ai.cloudcli.runtimecontroller

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred

/** What Termux's RunCommandService reported back for one dispatched command. */
data class TermuxCommandResult(
    val exitCode: Int?,
    val stdout: String,
    val stderr: String,
    /** Set when Termux itself could not run the command (e.g. permission not granted) — distinct from the command's own non-zero exit code. */
    val executionError: String?,
    /** Diagnostic only: whether the nested "result" Bundle itself was found on the callback intent. */
    val bundlePresent: Boolean = true,
    /** Diagnostic only: Termux's own `err` field (-1 == no internal error). */
    val errCode: Int? = null,
)

/**
 * Receives the RUN_COMMAND result Termux delivers via the PendingIntent we
 * attach to each dispatched command (`RUN_COMMAND_SERVICE.EXTRA_PENDING_INTENT`,
 * literal key `"com.termux.RUN_COMMAND_PENDING_INTENT"`), and hands it to
 * whichever caller is waiting on that request id.
 *
 * `android:exported="false"` in the manifest means only this app's own
 * PendingIntent can trigger this receiver — Termux fires the PendingIntent we
 * gave it, it does not broadcast to the system.
 *
 * The actual Bundle/key parsing lives in [TermuxResultParser] — pure, no
 * Android types — and is unit-tested there. This class is now just the thin
 * Android-framework glue: pull the nested Bundle (or fall back to flat
 * extras) out of a real [Intent], and correlate by request id.
 */
class TermuxResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getIntExtra(EXTRA_REQUEST_ID, -1)
        val nested = intent.getBundleExtra(TermuxResultParser.RESULT_BUNDLE_KEY)
        val source: (String) -> Any? = if (nested != null) {
            { key -> nested.get(key) }
        } else {
            { key -> intent.extras?.get(key) }
        }
        resolveRequest(requestId, TermuxResultParser.parse(nested != null, source))
    }

    companion object {
        private const val EXTRA_REQUEST_ID = "ai.cloudcli.runtimecontroller.REQUEST_ID"

        private val nextRequestId = AtomicInteger(1)
        private val pendingRequests = ConcurrentHashMap<Int, CompletableDeferred<TermuxCommandResult>>()

        /** Registers a waiter and returns the request id to stamp on the outgoing intent+PendingIntent. */
        fun register(deferred: CompletableDeferred<TermuxCommandResult>): Int {
            val id = nextRequestId.getAndIncrement()
            pendingRequests[id] = deferred
            return id
        }

        fun unregister(requestId: Int) {
            pendingRequests.remove(requestId)
        }

        fun requestIdExtraKey(): String = EXTRA_REQUEST_ID

        /**
         * Delivers [result] to whichever waiter registered [requestId], if
         * any. Pure w.r.t. Android — split out from [onReceive] so the
         * correlation logic itself (a stale/unknown id from an
         * already-timed-out request; two concurrent requests resolving out
         * of order) is exercisable directly from a JVM unit test. Returns
         * whether a waiter was actually found.
         */
        fun resolveRequest(requestId: Int, result: TermuxCommandResult): Boolean {
            val pending = if (requestId >= 0) pendingRequests.remove(requestId) else null
            pending?.complete(result)
            return pending != null
        }
    }
}
