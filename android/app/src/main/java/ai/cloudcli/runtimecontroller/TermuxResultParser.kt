package ai.cloudcli.runtimecontroller

/**
 * Pure parsing of a Termux RUN_COMMAND result. No Android types — [source]
 * abstracts "read this key from wherever the real Bundle/Intent put it", so
 * this is testable with a plain map-backed fake instead of a real
 * `android.os.Bundle` (which throws "not mocked" in local JVM unit tests).
 *
 * KEY NAMES, why they matter — this was the actual bug: termux-app's own
 * Java constants are *named* `TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE`,
 * `..._STDOUT` / `..._STDERR` / `..._EXIT_CODE` / `..._ERR` / `..._ERRMSG`
 * for documentation, but the *string values* those constants hold — the
 * actual Bundle keys Termux puts data under at runtime — are short:
 * `"result"`, `"stdout"`, `"stderr"`, `"exitCode"`, `"err"`, `"errmsg"`
 * (confirmed two ways: against termux-app's own `TermuxConstants.java`
 * source, and by extracting every literal string baked into the Termux APK
 * actually installed on the test device — none of the dotted constant
 * *names* appear anywhere in that binary). The previous version of this
 * parser used the dotted constant names as if they were the key values, so
 * every lookup silently missed: `getBundleExtra("TERMUX_SERVICE.EXTRA_..")`
 * never found the real bundle (stored under `"result"`), and the flat-extras
 * fallback never found the real fields either. The result always looked
 * like "no output" — indistinguishable from Termux never having run the
 * command at all, which is exactly the device symptom that survived the
 * separate Node-bootstrap fix unchanged.
 */
object TermuxResultParser {
    const val RESULT_BUNDLE_KEY = "result"
    const val STDOUT_KEY = "stdout"
    const val STDERR_KEY = "stderr"
    const val EXIT_CODE_KEY = "exitCode"
    const val ERR_KEY = "err"
    const val ERRMSG_KEY = "errmsg"

    /**
     * `err`'s value when Termux raised no internal error. Termux's own wiki
     * documents this as reusing `Activity.RESULT_OK`, whose platform value is
     * `-1` — not `0`, which is `Activity.RESULT_CANCELED`.
     */
    const val ERR_OK = -1

    /**
     * @param bundlePresent whether the nested "result" Bundle itself was
     *   found on the callback intent (as opposed to every field inside it
     *   happening to be absent) — surfaced on the result purely as a
     *   diagnostic, never used to decide success/failure itself.
     * @param source reads one extra by key from that nested bundle, or from
     *   flat intent extras as a defensive fallback when no nested bundle was
     *   found at all (termux-app always nests one, per its wiki, but this
     *   keeps parsing from going fully blind against a fork or future
     *   version that doesn't).
     */
    fun parse(bundlePresent: Boolean, source: (String) -> Any?): TermuxCommandResult {
        val errCode = (source(ERR_KEY) as? Number)?.toInt()
        // err accompanies errmsg but is only meaningful as a failure signal
        // when it's not the "no internal error" sentinel — treating any
        // present errmsg as fatal would misreport a normal completion.
        val executionError = if (errCode != null && errCode != ERR_OK) {
            (source(ERRMSG_KEY) as? String)?.takeIf { it.isNotBlank() }
                ?: "Termux reported an internal error (err=$errCode)."
        } else {
            null
        }
        return TermuxCommandResult(
            exitCode = (source(EXIT_CODE_KEY) as? Number)?.toInt(),
            stdout = source(STDOUT_KEY) as? String ?: "",
            stderr = source(STDERR_KEY) as? String ?: "",
            executionError = executionError,
            bundlePresent = bundlePresent,
            errCode = errCode,
        )
    }
}
