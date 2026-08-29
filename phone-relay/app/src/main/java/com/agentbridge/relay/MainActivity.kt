package com.agentbridge.relay

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    private var relayServer: RelayServer? = null
    private var mdns: MdnsBroadcaster? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("relay", Context.MODE_PRIVATE)
        val savedHost = prefs.getString("pc_host", RelayConfig.DEFAULT_HOST) ?: RelayConfig.DEFAULT_HOST
        val savedPort = prefs.getInt("pc_port", RelayConfig.DEFAULT_PORT)

        setContent {
            RelayScreen(
                initialHost = savedHost,
                initialPort = savedPort.toString(),
                onStart = { host, port ->
                    prefs.edit().putString("pc_host", host).putInt("pc_port", port).apply()
                    relayServer = RelayServer(RelayConfig(host, port)).also { it.start() }
                    mdns = MdnsBroadcaster(this, RelayConfig.LISTEN_PORT).also { it.start() }
                },
                onStop = ::stopRelay,
            )
        }
    }

    private fun stopRelay() {
        relayServer?.stop()
        relayServer = null
        mdns?.stop()
        mdns = null
    }

    override fun onDestroy() {
        stopRelay()
        super.onDestroy()
    }
}

@Composable
fun RelayScreen(
    initialHost: String,
    initialPort: String,
    onStart: (String, Int) -> Unit,
    onStop: () -> Unit,
) {
    var host by remember { mutableStateOf(initialHost) }
    var port by remember { mutableStateOf(initialPort) }
    var running by remember { mutableStateOf(false) }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("AgentBridge 手机中继", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("PC Tailscale IP") },
                enabled = !running,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = port,
                onValueChange = { port = it },
                label = { Text("PC 端口") },
                enabled = !running,
            )
            Spacer(Modifier.height(16.dp))
            Button(
                enabled = !running && host.isNotBlank() &&
                    (port.toIntOrNull()?.let { it in 1..65535 } == true),
                onClick = {
                    onStart(host.trim(), port.toInt())
                    running = true
                },
            ) { Text("启动中继") }
            Spacer(Modifier.height(8.dp))
            Button(
                enabled = running,
                onClick = {
                    onStop()
                    running = false
                },
            ) { Text("停止") }
            if (running) {
                Spacer(Modifier.height(16.dp))
                Text("中继运行中（监听 :8088，广播 _agentbridge._tcp）")
            }
        }
    }
}
