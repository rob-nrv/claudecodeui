package ai.cloudcli.runtimecontroller

import org.json.JSONObject

/**
 * Mirrors `server/modules/runtime/runtime-status.ts`'s `RuntimeStatus` contract
 * verbatim (the `cloudcli runtime status --json` output). This app never
 * recomputes "online" itself — it only parses what the backend already
 * decided, so a status here can never disagree with `cloudcli runtime status`
 * run by hand.
 */
data class RuntimeStatusInfo(
    val state: String, // "stopped" | "starting" | "online" | "stopping" | "error"
    val reason: String,
    val ownedByMarker: Boolean,
    val instanceId: String?,
    val url: String?,
    val pid: Int?,
) {
    companion object {
        fun fromJson(json: JSONObject): RuntimeStatusInfo = RuntimeStatusInfo(
            state = json.getString("state"),
            reason = json.optString("reason", ""),
            ownedByMarker = json.optBoolean("ownedByMarker", false),
            instanceId = json.optStringOrNull("instanceId"),
            url = json.optStringOrNull("url"),
            pid = if (json.isNull("pid")) null else json.optInt("pid"),
        )
    }
}

/** Mirrors `RuntimeStartResult` from `runtime-start.service.ts`. */
data class RuntimeStartResultInfo(
    val outcome: String,
    val newInstanceId: String?,
    val status: RuntimeStatusInfo,
    val launchError: String?,
) {
    companion object {
        fun fromJson(json: JSONObject): RuntimeStartResultInfo = RuntimeStartResultInfo(
            outcome = json.getString("outcome"),
            newInstanceId = json.optStringOrNull("newInstanceId"),
            status = RuntimeStatusInfo.fromJson(json.getJSONObject("status")),
            launchError = json.optStringOrNull("launchError"),
        )
    }
}

/** Mirrors `RuntimeStopResult` from `runtime-controller.service.ts`. */
data class RuntimeStopResultInfo(
    val outcome: String,
    val status: RuntimeStatusInfo,
) {
    companion object {
        fun fromJson(json: JSONObject): RuntimeStopResultInfo = RuntimeStopResultInfo(
            outcome = json.getString("outcome"),
            status = RuntimeStatusInfo.fromJson(json.getJSONObject("status")),
        )
    }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) getString(key) else null
