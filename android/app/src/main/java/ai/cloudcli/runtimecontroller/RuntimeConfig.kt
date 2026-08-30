package ai.cloudcli.runtimecontroller

import android.content.Context
import android.content.pm.PackageManager

/**
 * Everything this app needs to know to reach a specific person's CloudCLI
 * install, split by where the value may come from. Nothing here is a literal
 * default for one person's phone — an empty/missing value means "ask the user
 * in Settings", not "assume Robin's Pixel".
 *
 * - AUTO-DETECT:  [isTermuxInstalled] — read from the OS, never stored.
 * - INTERNAL DEFAULT: Termux's own filesystem layout ([TERMUX_PREFIX],
 *   [TERMUX_HOME]) and the proot-distro alias ([DEFAULT_DISTRO]) — fixed by
 *   Termux itself and by the `proot-distro install ubuntu` convention the
 *   mission's manual steps already use, not specific to any one install.
 * - USER CONFIG: [distro], [prootUsername], [repoPath] — cannot be known
 *   without asking; persisted in this app's own SharedPreferences only.
 */
class RuntimeConfig(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val applicationContext = context.applicationContext

    /** The proot-distro distro alias, e.g. "ubuntu". Empty until the user sets it. */
    var distro: String
        get() = prefs.getString(KEY_DISTRO, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DISTRO, value).apply()

    /** The Linux user inside that distro whose home holds the CloudCLI checkout. */
    var prootUsername: String
        get() = prefs.getString(KEY_USERNAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    /** Absolute path to the CloudCLI checkout inside the distro, e.g. "~/projects/claudecodeui". */
    var repoPath: String
        get() = prefs.getString(KEY_REPO_PATH, "") ?: ""
        set(value) = prefs.edit().putString(KEY_REPO_PATH, value).apply()

    /** The port `cloudcli` was built to serve on. Matches the backend's own default. */
    var serverPort: Int
        get() = prefs.getInt(KEY_PORT, DEFAULT_SERVER_PORT)
        set(value) = prefs.edit().putInt(KEY_PORT, value).apply()

    val isConfigured: Boolean
        get() = distro.isNotBlank() && prootUsername.isNotBlank() && repoPath.isNotBlank()

    fun isTermuxInstalled(): Boolean = try {
        applicationContext.packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    companion object {
        private const val PREFS_NAME = "runtime_config"
        private const val KEY_DISTRO = "distro"
        private const val KEY_USERNAME = "proot_username"
        private const val KEY_REPO_PATH = "repo_path"
        private const val KEY_PORT = "server_port"

        const val DEFAULT_SERVER_PORT = 3001
        const val DEFAULT_DISTRO = "ubuntu"
        const val TERMUX_PACKAGE = "com.termux"

        // Fixed by Termux's own install layout on every device — not this user's path.
        const val TERMUX_PREFIX = "/data/data/com.termux/files/usr"
        const val TERMUX_HOME = "/data/data/com.termux/files/home"
    }
}
