package dev.blackoutburst.companion

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels()
    private var awaitingBrowser = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent {
            val theme by model.theme.collectAsStateWithLifecycle()
            val tones = tonesFor(theme)
            LaunchedEffect(tones.dark) {
                val bars = if (tones.dark) SystemBarStyle.dark(Color.TRANSPARENT)
                else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
                window.setBackgroundDrawable(ColorDrawable(tones.top.toArgb()))
            }
            CompanionApp(model, tones, ::openBrowser)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() { super.onStart(); Push.foreground = true; Push.clearShown(this); model.setVisible(true) }
    override fun onStop() { super.onStop(); Push.foreground = false; model.setVisible(false) }

    override fun onResume() {
        super.onResume()
        // Back from the browser without the sign-in link: let the person try again.
        if (awaitingBrowser) { awaitingBrowser = false; window.decorView.postDelayed({ model.signInAbandoned() }, 800) }
    }

    private fun handle(intent: Intent?) {
        intent?.getStringExtra(Push.EXTRA_THREAD)?.let { threadId ->
            val board = intent.getBooleanExtra(Push.EXTRA_BOARD, false)
            intent.removeExtra(Push.EXTRA_THREAD); intent.removeExtra(Push.EXTRA_BOARD)
            model.openThread(threadId, board)
        }
        intent?.getStringExtra(Push.EXTRA_GROUP)?.let { groupId ->
            intent.removeExtra(Push.EXTRA_GROUP)
            model.openGroup(groupId)
        }
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
