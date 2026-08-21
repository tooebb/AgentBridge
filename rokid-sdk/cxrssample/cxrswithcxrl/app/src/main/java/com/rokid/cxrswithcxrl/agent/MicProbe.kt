package com.rokid.cxrswithcxrl.agent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import kotlin.math.abs
import kotlin.math.sqrt

object MicProbe {
    private const val TAG = "MICPROBE"
    private const val SAMPLE_RATE = 16000
    private const val CAPTURE_MS = 15_000L
    private const val CHUNK_MS = 1_000L

    fun permissionGranted(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    fun run(context: Context, onUpdate: (String) -> Unit) {
        Log.d(TAG, "probe start")
        if (!permissionGranted(context)) {
            onUpdate("MIC: no RECORD_AUDIO")
            return
        }

        val minBuf = try {
            AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
        } catch (e: Exception) {
            onUpdate("MIC: minBuf err ${e.javaClass.simpleName}")
            return
        }
        if (minBuf <= 0) {
            onUpdate("MIC: no input dev (minBuf=$minBuf)")
            return
        }

        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2
            )
        } catch (e: Exception) {
            onUpdate("MIC: ctor err ${e.javaClass.simpleName}")
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            onUpdate("MIC: state=${record.state}")
            return
        }
        try {
            record.startRecording()
        } catch (e: Exception) {
            record.release()
            onUpdate("MIC: start err ${e.javaClass.simpleName}")
            return
        }

        val buffer = ShortArray(minBuf)
        var samples = 0L
        var sumSq = 0.0
        var peak = 0.0
        var lastReport = System.currentTimeMillis()
        val start = System.currentTimeMillis()
        try {
            while (System.currentTimeMillis() - start < CAPTURE_MS) {
                val n = record.read(buffer, 0, buffer.size)
                if (n > 0) {
                    for (i in 0 until n) {
                        val v = buffer[i].toDouble()
                        sumSq += v * v
                        val a = abs(v)
                        if (a > peak) peak = a
                    }
                    samples += n
                }
                val now = System.currentTimeMillis()
                if (now - lastReport >= CHUNK_MS) {
                    val rms = if (samples > 0) sqrt(sumSq / samples) else 0.0
                    onUpdate("MIC: peak=%.0f rms=%.0f".format(peak, rms))
                    lastReport = now
                }
            }
        } finally {
            try { record.stop() } catch (_: Exception) {}
            record.release()
        }
        val rms = if (samples > 0) sqrt(sumSq / samples) else 0.0
        onUpdate("MIC DONE: peak=%.0f rms=%.0f".format(peak, rms))
        Log.d(TAG, "done peak=$peak rms=$rms samples=$samples")
    }
}
