package ai.cloudcli.runtimecontroller

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * The whole app: one screen, four states (Checking is a fifth, transient one
 * that never shows a special label — it renders as a quiet OFFLINE until the
 * first status answer arrives). No navigation stack, no chat/session UI —
 * this app only turns the runtime on, off, and hands off to a browser.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var config: RuntimeConfig
    private lateinit var controller: RuntimeController

    private lateinit var stateLabel: TextView
    private lateinit var messageText: TextView
    private lateinit var progressRow: LinearLayout
    private lateinit var progressText: TextView
    private lateinit var checklist: LinearLayout
    private lateinit var stepViews: List<TextView>
    private lateinit var primaryAction: android.widget.Button
    private lateinit var secondaryAction: android.widget.Button
    private lateinit var detailsText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        config = RuntimeConfig(this)
        controller = RuntimeController(TermuxRuntimeAdapter(applicationContext, config), lifecycleScope)

        stateLabel = findViewById(R.id.stateLabel)
        messageText = findViewById(R.id.messageText)
        progressRow = findViewById(R.id.progressRow)
        progressText = findViewById(R.id.progressText)
        checklist = findViewById(R.id.checklist)
        stepViews = listOf(
            findViewById(R.id.step1),
            findViewById(R.id.step2),
            findViewById(R.id.step3),
            findViewById(R.id.step4),
        )
        primaryAction = findViewById(R.id.primaryAction)
        secondaryAction = findViewById(R.id.secondaryAction)
        detailsText = findViewById(R.id.detailsText)

        secondaryAction.setOnClickListener { controller.stop() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                controller.state.collectLatest { render(it) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        controller.refreshStatus()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(Menu.NONE, MENU_SETTINGS, Menu.NONE, R.string.action_settings)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == MENU_SETTINGS) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    private fun render(screenState: RuntimeScreenState) {
        checklist.visibility = android.view.View.GONE
        progressRow.visibility = android.view.View.GONE
        detailsText.visibility = android.view.View.GONE
        secondaryAction.visibility = android.view.View.GONE
        primaryAction.isEnabled = true

        when (screenState) {
            is RuntimeScreenState.Checking -> {
                stateLabel.text = getString(R.string.state_offline)
                messageText.text = getString(R.string.message_checking)
                primaryAction.text = getString(R.string.action_start)
                primaryAction.isEnabled = false
                primaryAction.setOnClickListener(null)
            }

            is RuntimeScreenState.Offline -> {
                stateLabel.text = getString(R.string.state_offline)
                messageText.text = screenState.error?.message ?: getString(R.string.message_offline)
                primaryAction.text = getString(R.string.action_start)
                primaryAction.setOnClickListener { controller.start() }
                if (screenState.error != null) showDetails(screenState.error.details)
            }

            is RuntimeScreenState.Starting -> {
                stateLabel.text = getString(R.string.state_starting)
                messageText.text = getString(R.string.message_starting)
                primaryAction.text = getString(R.string.action_start)
                primaryAction.isEnabled = false
                primaryAction.setOnClickListener(null)
                renderChecklist(screenState.completedSteps)
            }

            is RuntimeScreenState.Stopping -> {
                // Deliberately NOT a re-entry guard: RuntimeController.busy already
                // refuses a second dispatch synchronously. Disabling these two
                // controls here is only the visible half of that same rule, so the
                // screen never looks idle while STOP is actually in flight.
                stateLabel.text = getString(R.string.state_stopping)
                messageText.text = getString(R.string.message_stopping)
                progressRow.visibility = android.view.View.VISIBLE
                progressText.text = getString(R.string.message_stopping)
                primaryAction.text = getString(R.string.action_open)
                primaryAction.isEnabled = false
                primaryAction.setOnClickListener(null)
                secondaryAction.visibility = android.view.View.VISIBLE
                secondaryAction.isEnabled = false
            }

            is RuntimeScreenState.Online -> {
                stateLabel.text = getString(R.string.state_online)
                messageText.text = getString(R.string.message_online)
                primaryAction.text = getString(R.string.action_open)
                primaryAction.setOnClickListener { openWebUi() }
                secondaryAction.visibility = android.view.View.VISIBLE
                secondaryAction.isEnabled = true
            }

            is RuntimeScreenState.Error -> {
                stateLabel.text = getString(R.string.state_error)
                messageText.text = screenState.error.message
                primaryAction.text = getString(R.string.action_retry)
                primaryAction.setOnClickListener { controller.start() }
                showDetails(screenState.error.details)
            }
        }
    }

    /** Each row's checklist label and the caption shown next to the spinner while it is the active step. */
    private val startStepOrder = listOf(
        Triple(StartStep.RUNTIME_AVAILABLE, R.string.step_runtime_available, R.string.progress_runtime_available),
        Triple(StartStep.LINUX_ENVIRONMENT, R.string.step_linux_environment, R.string.progress_linux_environment),
        Triple(StartStep.CLOUDCLI_SERVER, R.string.step_cloudcli_server, R.string.progress_cloudcli_server),
        Triple(StartStep.HEALTH_CHECK, R.string.step_health_check, R.string.progress_health_check),
    )

    private fun renderChecklist(completed: Set<StartStep>) {
        checklist.visibility = android.view.View.VISIBLE
        startStepOrder.forEachIndexed { index, (step, labelRes, _) ->
            val done = step in completed
            stepViews[index].text = "${if (done) "✓" else "○"} ${getString(labelRes)}"
        }

        // The active step gets the real, indeterminate spinner — never a fake percentage.
        // Once every step is checked off there is nothing left to spin for; the fully
        // ticked checklist itself is the last STARTING frame, held for real by
        // RuntimeController's yield() before ONLINE replaces it.
        val active = startStepOrder.firstOrNull { (step, _, _) -> step !in completed }
        if (active == null) {
            progressRow.visibility = android.view.View.GONE
        } else {
            progressRow.visibility = android.view.View.VISIBLE
            progressText.text = getString(active.third)
        }
    }

    private fun showDetails(details: String) {
        detailsText.visibility = android.view.View.VISIBLE
        detailsText.text = details
    }

    private fun openWebUi() {
        val url = controller.webUrl() ?: return
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    companion object {
        private const val MENU_SETTINGS = 1
    }
}
