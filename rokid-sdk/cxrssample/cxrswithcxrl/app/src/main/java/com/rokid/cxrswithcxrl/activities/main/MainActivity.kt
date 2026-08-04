package com.rokid.cxrswithcxrl.activities.main

import android.content.IntentFilter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
    private val clickHandler = Handler(Looper.getMainLooper())
    private var pendingSecondClick: Runnable? = null
    private var gestureLockUntil = 0L



    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Also set on decor view for glasses that may override window flags
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
    }

    override fun onDestroy() {
        pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
        unregisterReceiver(viewModel.keyReceiver)
        if (wakeLock.isHeld) {
            wakeLock.release()
        }
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        Log.d("INPUT", "onKeyDown: keyCode=$keyCode action=${event?.action}")
        viewModel.showInputDebug("keyDown=$keyCode")
        when (keyCode) {
            83 -> {
                if (System.currentTimeMillis() < gestureLockUntil) {
                    return true
                }
                val pending = pendingSecondClick
                if (pending != null) {
                    clickHandler.removeCallbacks(pending)
                    pendingSecondClick = null
                    viewModel.onGesture("reject")
                } else {
                    val runnable = Runnable {
                        pendingSecondClick = null
                        viewModel.onGesture("approve")
                    }
                    pendingSecondClick = runnable
                    clickHandler.postDelayed(runnable, 500L)
                }
                return true
            }
            19, 20 -> {
                pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
                pendingSecondClick = null
                gestureLockUntil = System.currentTimeMillis() + 500L
                viewModel.onGesture("view_details")
                return true
            }
            4 -> { viewModel.onGesture("reject"); return true }
        }
        return super.onKeyDown(keyCode, event)
    }
    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        Log.d("INPUT", "onKeyUp: keyCode=$keyCode action=${event?.action}")
        viewModel.showInputDebug("keyUp=$keyCode")
        when (keyCode) {
            19, 20 -> {
                pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
                pendingSecondClick = null
                gestureLockUntil = System.currentTimeMillis() + 500L
                viewModel.onGesture("view_details")
                return true
            }
        }
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
    AgentBridgeScreen(card = agentCard, capsFromClient = fromClient, debugStatus = debugStatus)
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    CXRSWithCXRLTheme {
        AgentBridgeScreen(card = AgentCardState(), capsFromClient = "subscribe: preview")
    }
}
