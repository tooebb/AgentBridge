package com.agentbridge.relay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.IBinder
import android.os.Looper

class RelayService : Service() {
    private var relayServer: RelayServer? = null
    private var audioServer: RelayServer? = null
    private var mdnsBroadcaster: MdnsBroadcaster? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val rebroadcastHandler = Handler(Looper.getMainLooper())
    private val rebroadcastRunnable = Runnable { rebroadcastMdns() }

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Phone relay",
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        if (isRunning) return START_STICKY

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val host = prefs.getString(KEY_PC_HOST, RelayConfig.DEFAULT_HOST) ?: RelayConfig.DEFAULT_HOST
        val port = prefs.getInt(KEY_PC_PORT, RelayConfig.DEFAULT_PORT)

        relayServer = RelayServer(RelayConfig(host, port)).also { it.start() }
        audioServer = RelayServer(
            RelayConfig(host, RelayConfig.AUDIO_PORT),
            RelayConfig.AUDIO_PORT,
        ).also { it.start() }
        mdnsBroadcaster = MdnsBroadcaster(this, RelayConfig.LISTEN_PORT).also { it.start() }
        isRunning = true
        registerNetworkCallback()
        return START_STICKY
    }

    override fun onDestroy() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { cm?.unregisterNetworkCallback(it) }
        networkCallback = null
        rebroadcastHandler.removeCallbacks(rebroadcastRunnable)
        relayServer?.stop()
        relayServer = null
        audioServer?.stop()
        audioServer = null
        mdnsBroadcaster?.stop()
        mdnsBroadcaster = null
        isRunning = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scheduleRebroadcast()
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                scheduleRebroadcast()
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                scheduleRebroadcast()
            }
        }
        networkCallback = callback
        cm.registerDefaultNetworkCallback(callback)
    }

    private fun scheduleRebroadcast() {
        rebroadcastHandler.removeCallbacks(rebroadcastRunnable)
        rebroadcastHandler.postDelayed(rebroadcastRunnable, REBROADCAST_DEBOUNCE_MS)
    }

    private fun rebroadcastMdns() {
        if (!isRunning) return
        mdnsBroadcaster?.restart()
    }

    private fun buildNotification(): Notification = Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("AgentBridge 手机中继")
        .setContentText("中继运行中（监听 :${RelayConfig.LISTEN_PORT} / :${RelayConfig.AUDIO_PORT}）")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setOngoing(true)
        .build()

    companion object {
        @Volatile
        var isRunning = false
            private set
        private const val CHANNEL_ID = "relay"
        private const val NOTIFICATION_ID = 1
        private const val REBROADCAST_DEBOUNCE_MS = 500L
        private const val PREFS_NAME = "relay"
        private const val KEY_PC_HOST = "pc_host"
        private const val KEY_PC_PORT = "pc_port"
    }
}
