package ai.cloudcli.runtimecontroller

/**
 * Pure decision logic for the Android-side verified START. No Android types —
 * [TermuxRuntimeAdapter] wires the real RUN_COMMAND dispatch/poll/wait into
 * this, the same split the backend already uses between `runtime.module.ts`
 * (real IO) and `runtime-start.service.ts` (pure decision logic), which is
 * what keeps this testable from a plain JVM unit test the same way
 * [RuntimeController]'s tests use a `FakeAdapter`.
 *
 * WHY THIS EXISTS, root cause recap (device diagnosis C2-P1-L02-D01):
 * `proot-distro login` always passes `--kill-on-exit` on Termux, so a proot
 * session SIGKILLs every remaining tracee — including a detached server
 * child — the instant its main command exits. Routing START through
 * `cloudcli runtime start` made the CLI process itself that main command: it
 * would launch the server, observe it healthy, print its verdict, exit — and
 * take the server down with it. The backend's own `confirmStableOnline` runs
 * *inside* that same CLI process, so it structurally could never observe this
 * death; it always measured before the kill.
 *
 * The fix is topological, not a longer timer: the server itself must be the
 * proot session's main command (see
 * [TermuxCommandBuilder.buildServerLaunchCommand]), and the "did it actually
 * come up and stay up" verdict must come from a measurer *outside* that
 * session — repeated `cloudcli runtime status` calls dispatched as their own
 * short RUN_COMMANDs. That external vantage point is exactly what lets this
 * verifier catch a server that answered once and then died, which the old
 * backend-side check never could.
 */
object RuntimeStartVerifier {

    data class Policy(
        /** Cold proot/Termux boot budget for a first ONLINE reading to appear. */
        val serverOnlineTimeoutMs: Long = 90_000L,
        /** Spacing between status polls while waiting for that first ONLINE. */
        val statusPollIntervalMs: Long = 2_000L,
        /**
         * Extra consecutive ONLINE+owned readings required, same instance id,
         * before START is allowed to report success. Chosen independently of
         * the backend's own stability window: each check here is a full
         * RUN_COMMAND round trip (seconds), not an in-process call (ms), and
         * this measurer sits outside the server's proot session, so it is
         * only worth as much confidence as a few seconds' worth of checks
         * gives without turning every START into a long wait.
         */
        val stabilityConfirmations: Int = 3,
        /** Spacing between post-online confirmation polls. */
        val stabilityPollIntervalMs: Long = 1_000L,
    )

    /**
     * What Termux reported for the *launch command itself* once it exited —
     * null for as long as that command is still running, which for a healthy
     * server is the whole START.
     *
     * This is the missing observation that made the old failure message a
     * lie. START dispatches the server and then only ever watches `status`,
     * so a launch that died on the first line (wrong interpreter, missing
     * build, bad distro/user) looked exactly like a slow boot, and after 90s
     * the user was told "CloudCLI started but never became healthy" about a
     * process that never existed. A dispatch acknowledgement is not a running
     * server; this is what tells the two apart.
     */
    data class LaunchExit(
        val exitCode: Int?,
        val stderr: String,
        /** Termux's own failure to run the command at all, as opposed to the command's exit code. */
        val executionError: String?,
    )

    /** Upper bound on how much launch stderr is quoted back into a failure detail. */
    private const val STDERR_TAIL_CHARS = 600

    /**
     * @param preflightStatus a `status` reading taken before any dispatch decision.
     * @param dispatchServer fires the long-running server RUN_COMMAND; returns
     *   null on a successful dispatch, a [AdapterOutcome.Failure] if the
     *   command could not even be sent. Must not be awaited to completion —
     *   see [TermuxRuntimeAdapter]'s dispatch doc for why.
     * @param pollStatus one `status` observation, dispatched fresh each call.
     * @param wait suspends for the given duration; injected so tests can make
     *   it instant instead of really sleeping.
     * @param launchExit reports how the dispatched launch command ended, or
     *   null while it is still running. Only consulted once this call has
     *   actually dispatched something — when an in-flight start was adopted
     *   instead, there is no launch of ours to have an exit.
     * @param elapsedMs a monotonic millisecond clock; injected for the same reason.
     */
    suspend fun start(
        preflightStatus: RuntimeStatusInfo,
        dispatchServer: suspend () -> AdapterOutcome.Failure?,
        pollStatus: suspend () -> AdapterOutcome<RuntimeStatusInfo>,
        wait: suspend (Long) -> Unit,
        onStep: (StartStep) -> Unit,
        elapsedMs: () -> Long,
        launchExit: () -> LaunchExit? = { null },
        policy: Policy = Policy(),
    ): AdapterOutcome<RuntimeStartResultInfo> {
        // A. Already online and provably ours: idempotent, nothing to launch.
        if (preflightStatus.state == "online" && preflightStatus.ownedByMarker) {
            return AdapterOutcome.Success(
                RuntimeStartResultInfo("already-running", preflightStatus.instanceId, preflightStatus, null),
            )
        }
        // B. Something answers but ownership is unprovable, or a different
        // instance holds the port: refuse rather than launch a second server.
        if (preflightStatus.state == "online" || preflightStatus.reason == "instance-mismatch") {
            return AdapterOutcome.Failure(
                userMessage = "Something else is already using CloudCLI's port.",
                details = "status reported state=${preflightStatus.state} reason=${preflightStatus.reason}.",
            )
        }

        // C. Genuinely stopped: dispatch. If a start already looked in flight
        // (fresh marker, no health yet), don't launch a second server on top
        // of it — just start observing.
        val dispatched = preflightStatus.state != "starting"
        if (dispatched) {
            dispatchServer()?.let { return it }
        }
        onStep(StartStep.LINUX_ENVIRONMENT)

        val waitStartedAt = elapsedMs()
        var status: RuntimeStatusInfo

        while (true) {
            // Checked before the status poll: when the launch is already dead,
            // "the command exited" is the true and useful answer, and the
            // "stopped" status that poll would return is just its shadow.
            if (dispatched) {
                launchExit()?.let { return launchFailure(it) }
            }
            when (val outcome = pollStatus()) {
                is AdapterOutcome.Failure -> return outcome
                is AdapterOutcome.Success -> {
                    status = outcome.value
                    if (status.state == "online" && status.ownedByMarker) break
                    if (status.state == "online" || status.reason == "instance-mismatch") {
                        return AdapterOutcome.Failure(
                            userMessage = "Something else is already using CloudCLI's port.",
                            details = "status reported state=${status.state} reason=${status.reason} " +
                                "while waiting for our own launch to come online.",
                        )
                    }
                }
            }
            if (elapsedMs() - waitStartedAt >= policy.serverOnlineTimeoutMs) {
                return AdapterOutcome.Failure(
                    userMessage = "CloudCLI started but never became healthy.",
                    details = "No verified ONLINE status within ${policy.serverOnlineTimeoutMs / 1000}s " +
                        "of dispatching the server.",
                )
            }
            wait(policy.statusPollIntervalMs)
        }

        // A first ONLINE reading also describes a process that answers once and
        // is gone a moment later. Re-observe it from this external vantage point
        // before calling START succeeded — any disappearance, foreign takeover,
        // or identity change during this window fails immediately; it does not
        // reset and keep trying, because a server that came up once and died is
        // exactly what must never report success.
        val confirmedInstanceId = status.instanceId
        repeat(policy.stabilityConfirmations) {
            wait(policy.stabilityPollIntervalMs)
            when (val outcome = pollStatus()) {
                is AdapterOutcome.Failure -> return outcome
                is AdapterOutcome.Success -> {
                    status = outcome.value
                    if (status.state != "online" || !status.ownedByMarker || status.instanceId != confirmedInstanceId) {
                        return AdapterOutcome.Failure(
                            userMessage = "CloudCLI started but didn't stay online.",
                            details = "Instance $confirmedInstanceId went to state=${status.state} " +
                                "reason=${status.reason} during post-start confirmation.",
                        )
                    }
                }
            }
        }

        onStep(StartStep.HEALTH_CHECK)
        return AdapterOutcome.Success(
            RuntimeStartResultInfo(outcome = "started", newInstanceId = status.instanceId, status = status, launchError = null),
        )
    }

    /**
     * Turns a dead launch into a message that says what actually happened.
     * Never claims CloudCLI started: by construction this is only reachable
     * when the launch command has already exited without the server ever
     * having been observed online.
     */
    private fun launchFailure(exit: LaunchExit): AdapterOutcome.Failure {
        val tail = exit.stderr.trim().takeLast(STDERR_TAIL_CHARS)
        return AdapterOutcome.Failure(
            userMessage = if (exit.executionError != null) {
                "Termux couldn't run the CloudCLI server."
            } else {
                "The CloudCLI server stopped before it came online."
            },
            details = buildString {
                append(
                    exit.executionError
                        ?: "The runtime launch command exited ${exit.exitCode ?: "?"} " +
                        "before the server ever answered as online.",
                )
                if (tail.isNotEmpty()) {
                    append("\n")
                    append(tail)
                }
            },
        )
    }
}
