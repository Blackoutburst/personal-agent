package dev.blackoutburst.companion

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent

class MainActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels()
    private var awaitingBrowser = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent { CompanionApp(model, ::openBrowser) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() { super.onStart(); model.setVisible(true) }
    override fun onStop() { super.onStop(); model.setVisible(false) }

    override fun onResume() {
        super.onResume()
        // Back from the browser without the sign-in link: let the person try again.
        if (awaitingBrowser) { awaitingBrowser = false; window.decorView.postDelayed({ model.signInAbandoned() }, 800) }
    }

    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action == Intent.ACTION_VIEW && data.scheme == "blackoutburst-companion") {
            awaitingBrowser = false
            model.signInLink(data)
            intent.data = null
        }
    }

    /** Sign-in happens in a Custom Tab (the real browser), never in a WebView. */
    private fun openBrowser(uri: Uri) {
        awaitingBrowser = true
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
    }
}
