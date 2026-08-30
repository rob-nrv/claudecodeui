package ai.cloudcli.runtimecontroller

import org.json.JSONObject

/**
 * Turns one [TermuxCommandResult] into an [AdapterOutcome], independent of
 * Android. [TermuxRuntimeAdapter] delegates here so this is unit-testable
 * with a real `org.json.JSONObject` (a test-only dependency provides one —
 * the platform's own copy that local unit tests otherwise compile/run
 * against throws "not mocked" for every method) instead of one built through
 * the whole RUN_COMMAND round trip.
 */
object TermuxResultOutcome {
    fun <T> from(result: TermuxCommandResult, verb: String, parse: (JSONObject) -> T): AdapterOutcome<T> {
        if (result.executionError != null) {
            return AdapterOutcome.Failure(
                userMessage = "Termux couldn't run that command.",
                details = result.executionError,
            )
        }
        // proot-distro itself failing (unknown distro, unknown user) exits non-zero with no
        // JSON on stdout — every `cloudcli runtime` subcommand always prints JSON on success.
        val jsonText = result.stdout.trim()
        if (jsonText.isEmpty()) {
            return AdapterOutcome.Failure(
                userMessage = "Couldn't reach the Linux environment.",
                details = "runtime $verb exited ${result.exitCode ?: "?"} with no output. " +
                    "[diagnostics: bundle=${if (result.bundlePresent) "present" else "absent"}, " +
                    "err=${result.errCode ?: "none"}, stderrLen=${result.stderr.length}]\n${result.stderr}",
            )
        }
        return try {
            AdapterOutcome.Success(parse(JSONObject(jsonText)))
        } catch (error: Exception) {
            AdapterOutcome.Failure(
                userMessage = "Got an unexpected response from CloudCLI.",
                details = "Could not parse: $jsonText\n${error.message}",
            )
        }
    }
}
