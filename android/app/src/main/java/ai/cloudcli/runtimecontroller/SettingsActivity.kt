package ai.cloudcli.runtimecontroller

import android.os.Bundle
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

/**
 * The one-time (or occasional) setup screen for the three values that cannot
 * be auto-detected from the Android side: which proot-distro distro, which
 * Linux user inside it, and where the CloudCLI checkout lives. Deliberately
 * plain — three fields and Save, no validation beyond non-blank, since the
 * real validation is "did Start work", surfaced on the main screen.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var config: RuntimeConfig

    private lateinit var distroInput: EditText
    private lateinit var usernameInput: EditText
    private lateinit var repoPathInput: EditText
    private lateinit var portInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        title = getString(R.string.settings_title)

        config = RuntimeConfig(this)

        distroInput = findViewById(R.id.distroInput)
        usernameInput = findViewById(R.id.usernameInput)
        repoPathInput = findViewById(R.id.repoPathInput)
        portInput = findViewById(R.id.portInput)

        distroInput.setText(config.distro.ifBlank { RuntimeConfig.DEFAULT_DISTRO })
        usernameInput.setText(config.prootUsername)
        repoPathInput.setText(config.repoPath)
        portInput.setText(config.serverPort.toString())

        findViewById<android.widget.Button>(R.id.saveButton).setOnClickListener {
            config.distro = distroInput.text.toString().trim()
            config.prootUsername = usernameInput.text.toString().trim()
            config.repoPath = repoPathInput.text.toString().trim()
            config.serverPort = portInput.text.toString().trim().toIntOrNull() ?: RuntimeConfig.DEFAULT_SERVER_PORT
            finish()
        }
    }
}
