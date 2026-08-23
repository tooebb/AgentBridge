package com.rokid.cxrswithcxrl.activities.main

import android.Manifest
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.ViewModelProvider
import com.rokid.cxrswithcxrl.agent.AgentBridgeScreen
import com.rokid.cxrswithcxrl.agent.AgentCardState
import com.rokid.cxrswithcxrl.agent.GestureHandler
import com.rokid.cxrswithcxrl.agent.MicProbe
import com.rokid.cxrswithcxrl.receiver.KeyReceiver
import com.rokid.cxrswithcxrl.receiver.KeyType
import com.rokid.cxrswithcxrl.ui.theme.CXRSWithCXRLTheme

/**
 * CustomApp entry Activity on glasses.
 *
 * Doc reference:
 * - CXR-L 眼镜端自定义应用: package `com.rokid.cxrswithcxrl`, entry `.activities.main.MainActivity`
 * - CXR-L 眼镜端按键与系统广播: dynamic [KeyReceiver] registration, key/back → [MainViewModel.sendMessage]
 *
 * Started by phone CXR-L `appStart` in CUSTOMAPP session (RenewCXRLSample [SessionHubViewModel]).
 */
class MainActivity : ComponentActivity() {

    private lateinit var viewModel: MainViewModel
    private lateinit var wakeLock: PowerManager.WakeLock
    @Volatile
    private var micProbeRunning = false
    private var micProbeThread: Thread? = null
    private val gestureHandler = GestureHandler { actionType ->
        viewModel.onGesture(actionType)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.keepScreenOn = true
        enableEdgeToEdge()
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "cxrswithcxrl:agentbridge"
        )
        wakeLock.acquire()
        viewModel = ViewModelProvider(this)[MainViewModel::class.java]
        viewModel.startAgentBridge(applicationContext)
        setContent {
            CXRSWithCXRLTheme {
                MainScreen(
                    viewModel = viewModel
                )
            }
        }
        onBackPressedDispatcher.addCallback(object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                viewModel.sendMessage("Back Pressed")
            }
        })
        registerReceiver(viewModel.keyReceiver, IntentFilter().apply {
            KeyType.entries.forEach {
                addAction(it.action)
            }
        })
        startMicProbe()
    }

    private fun startMicProbe() {
        if (MicProbe.permissionGranted(this)) {
            runMicProbe()
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
    }

    private fun runMicProbe() {
        if (micProbeThread?.isAlive == true) {
            return
        }
        micProbeRunning = true
        micProbeThread = Thread {
            MicProbe.run(
                context = this,
                shouldContinue = { micProbeRunning },
            ) { viewModel.showMicResult(it) }
        }.apply {
            name = "MicProbe"
            start()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                runMicProbe()
            } else {
                viewModel.showMicResult("MIC: permission denied")
            }
        }
    }

    companion object {
        private const val REQ_MIC = 101
    }

    override fun onDestroy() {
        micProbeRunning = false
        micProbeThread?.interrupt()
        gestureHandler.destroy()
        unregisterReceiver(viewModel.keyReceiver)
        if (wakeLock.isHeld) {
            wakeLock.release()
        }
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        Log.d("INPUT", "onKeyDown: keyCode=$keyCode action=${event?.action}")
        viewModel.showInputDebug("keyDown=$keyCode")
        if (gestureHandler.onKeyDown(keyCode)) return true
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        Log.d("INPUT", "onKeyUp: keyCode=$keyCode action=${event?.action}")
        viewModel.showInputDebug("keyUp=$keyCode")
        if (gestureHandler.onKeyUp(keyCode)) return true
        return super.onKeyUp(keyCode, event)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        Log.d("INPUT", "dispatchKeyEvent: keyCode=${event.keyCode} action=${event.action}")
        viewModel.showInputDebug("key=${event.keyCode}")
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        val a = event.actionMasked
        Log.d("INPUT", "dispatchGenericMotion: actionMasked=$a src=${event.source}")
        viewModel.showInputDebug("genMotion=$a")
        return super.dispatchGenericMotionEvent(event)
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        val a = event.actionMasked
        Log.d("INPUT", "onGenericMotion: actionMasked=$a src=${event.source}")
        viewModel.showInputDebug("genMotion2=$a")
        return super.onGenericMotionEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val a = event.actionMasked
        Log.d("INPUT", "dispatchTouch: actionMasked=$a action=${event.action} src=${event.source}")
        viewModel.showInputDebug("touch=$a")
        return super.dispatchTouchEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val a = event.actionMasked
        Log.d("INPUT", "onTouchEvent: actionMasked=$a")
        return super.onTouchEvent(event)
    }

}

@Composable
fun MainScreen(viewModel: MainViewModel) {
    val fromClient by viewModel.capsFromClient.collectAsState()
    val agentCard by viewModel.agentCard.collectAsState()
    val debugStatus by viewModel.debugStatus.collectAsState()
    val voiceStatus by viewModel.voiceStatus.collectAsState()
    AgentBridgeScreen(
        card = agentCard,
        capsFromClient = fromClient,
        debugStatus = debugStatus,
        voiceStatus = voiceStatus
    )
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    CXRSWithCXRLTheme {
        AgentBridgeScreen(card = AgentCardState(), capsFromClient = "subscribe: preview")
    }
}
