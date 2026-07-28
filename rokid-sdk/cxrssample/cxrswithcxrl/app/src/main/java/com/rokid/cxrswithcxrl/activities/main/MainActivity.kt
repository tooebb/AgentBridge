package com.rokid.cxrswithcxrl.activities.main

import android.content.IntentFilter
import android.os.Bundle
import android.view.KeyEvent
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



    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
        unregisterReceiver(viewModel.keyReceiver)
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        viewModel.sendMessage("Down keyCode = $keyCode， event = ${event?.action}")
        return super.onKeyDown(keyCode, event)
    }
    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        viewModel.sendMessage("Up keyCode = $keyCode， event = ${event?.action}")
        return super.onKeyUp(keyCode, event)
    }

}

@Composable
fun MainScreen(viewModel: MainViewModel) {
    val fromClient by viewModel.capsFromClient.collectAsState()
    val agentCard by viewModel.agentCard.collectAsState()
    AgentBridgeScreen(card = agentCard, capsFromClient = fromClient)
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    CXRSWithCXRLTheme {
        AgentBridgeScreen(card = AgentCardState(), capsFromClient = "subscribe: preview")
    }
}
