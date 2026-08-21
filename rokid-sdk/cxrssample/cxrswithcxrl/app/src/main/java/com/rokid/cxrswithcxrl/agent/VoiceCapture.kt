package com.rokid.cxrswithcxrl.agent

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

enum class VoiceCaptureState {
    IDLE,
    RECORDING,
}

class VoiceCapture(
    private val sampleRate: Int = 16000,
    private val onState: (VoiceCaptureState) -> Unit = {},
    private val onError: (String) -> Unit = {},
) {
    @Volatile
    var state: VoiceCaptureState = VoiceCaptureState.IDLE
        private set

    private val running = AtomicBoolean(false)
    private val httpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var record: AudioRecord? = null
    private var webSocket: WebSocket? = null
    private var worker: Thread? = null

    fun start(url: String) {
        if (!running.compareAndSet(false, true)) return
        setState(VoiceCaptureState.RECORDING)

        val minBuffer = try {
            AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        } catch (e: Exception) {
            fail("minBuffer ${e.javaClass.simpleName}")
            return
        }
        if (minBuffer <= 0) {
            fail("no input device minBuffer=$minBuffer")
            return
        }

        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuffer * 2,
            )
        } catch (e: Exception) {
            fail("AudioRecord ${e.javaClass.simpleName}")
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            fail("AudioRecord state=${rec.state}")
            return
        }
        record = rec

        val request = Request.Builder().url(url).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                startStreaming(rec, webSocket, minBuffer)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("stop")) {
                    stop()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onError("audio ws failed: ${t.message ?: t.javaClass.simpleName}")
                stop()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                stop()
            }
        })
    }

    fun stop() {
        if (!running.getAndSet(false)) return

        try { record?.stop() } catch (_: Exception) {}
        record?.release()
        record = null
        webSocket?.close(1000, "done")
        webSocket = null
        worker = null
        setState(VoiceCaptureState.IDLE)
    }

    private fun startStreaming(rec: AudioRecord, ws: WebSocket, minBuffer: Int) {
        worker = Thread {
            try {
                rec.startRecording()
                streamPcm(rec, ws, minBuffer)
            } catch (e: Exception) {
                onError("record failed: ${e.javaClass.simpleName}")
                stop()
            }
        }.apply {
            name = "VoiceCapture"
            start()
        }
    }

    private fun streamPcm(rec: AudioRecord, ws: WebSocket, minBuffer: Int) {
        val buffer = ShortArray(minBuffer)
        while (running.get()) {
            val count = rec.read(buffer, 0, buffer.size)
            if (count <= 0) continue

            val bytes = ByteArray(count * 2)
            for (i in 0 until count) {
                val value = buffer[i].toInt()
                bytes[i * 2] = (value and 0xff).toByte()
                bytes[i * 2 + 1] = ((value shr 8) and 0xff).toByte()
            }
            if (!ws.send(ByteString.of(*bytes))) {
                onError("audio ws send failed")
                stop()
                return
            }
        }
    }

    private fun fail(message: String) {
        onError(message)
        running.set(false)
        setState(VoiceCaptureState.IDLE)
    }

    private fun setState(next: VoiceCaptureState) {
        state = next
        onState(next)
    }
}
