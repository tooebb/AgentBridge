package com.rokid.renewcxrlsample.activities.audio

import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.os.Environment
import androidx.core.content.FileProvider
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.link.CXRLink
import com.rokid.cxr.link.callbacks.IAudioStreamCbk
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.app.CXRLApplication
import com.rokid.renewcxrlsample.session.CxrSessionType
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub
import com.rokid.sprite.aiapp.externalapp.auth.AuthorizationHelper
import com.rokid.sprite.aiapp.externalapp.auth.GlassPermission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Business ViewModel for audio capability.
 *
 * Reuses established CXRLink session and manages audio stream capture,
 * PCM/WAV persistence, local playback, sharing, and history cleanup.
 */
class AudioUsageViewModel: ViewModel () {
    private val tag = "AudioUsageViewModel"

    private val _tokenGot = MutableStateFlow(false)
    val tokenGot = _tokenGot.asStateFlow()

    private val _audioStarted = MutableStateFlow(false)
    val audioStarted = _audioStarted.asStateFlow()

    private val _status = MutableStateFlow("")
    val status = _status.asStateFlow()

    private val _ready = MutableStateFlow(false)
    val ready = _ready.asStateFlow()

    private val _permissionGranted = MutableStateFlow(false)
    val permissionGranted = _permissionGranted.asStateFlow()

    private val _entryLabel = MutableStateFlow("")
    val entryLabel = _entryLabel.asStateFlow()

    private val _hasPlayableAudio = MutableStateFlow(false)
    val hasPlayableAudio = _hasPlayableAudio.asStateFlow()

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying = _isPlaying.asStateFlow()

    private val _savedAudioPath = MutableStateFlow("")
    val savedAudioPath = _savedAudioPath.asStateFlow()

    private val _recordDurationText = MutableStateFlow("")
    val recordDurationText = _recordDurationText.asStateFlow()

    private val _cleanupResult = MutableStateFlow("")
    val cleanupResult = _cleanupResult.asStateFlow()

    private val _audioFileCountText = MutableStateFlow("")
    val audioFileCountText = _audioFileCountText.asStateFlow()

    private val _recentAudioFilesText = MutableStateFlow("")
    val recentAudioFilesText = _recentAudioFilesText.asStateFlow()

    private lateinit var cxrLink: CXRLink
    private var appContext: Context? = null
    private var entryTypeValue: String = CONSTANT.ENTRY_TYPE_CUSTOM_APP
    private var pcmFile: File? = null
    private var wavFile: File? = null
    private var pcmOutputStream: FileOutputStream? = null
    private var pcmDataSize: Long = 0L
    private var mediaPlayer: MediaPlayer? = null
    private val fileLock = Any()
    private var audioChunkCount: Long = 0
    private var firstAudioChunkAtMs: Long = 0
    private var totalWrittenBytes: Long = 0
    private var showAiInterruptStatusOnStreamStart = false

    /**
     * Audio stream callback.
     *
     * Key points:
     * - Guard SDK offset/length ranges before writing.
     * - Use file lock for thread-safe write/close flow.
     * - Record statistics for diagnosing missing/short-audio issues.
     */
    private val audioCallback = object : IAudioStreamCbk {
        override fun onAudioReceived(data: ByteArray?, offset: Int, length: Int) {

            Log.d(tag, "onAudioReceived data.size =  ${data?.size} offset=$offset length=$length")

            if (data == null || length <= 0) {
                Log.w(tag, "onAudioReceived ignored: data=${data?.size}, length=$length")
                return
            }
            if (firstAudioChunkAtMs == 0L) {
                firstAudioChunkAtMs = System.currentTimeMillis()
            }
            audioChunkCount += 1
            synchronized(fileLock) {
                pcmOutputStream?.let { output ->
                    runCatching {
                        // Some SDK callbacks may provide out-of-range offset/length.
                        Log.d(tag, "onAudioReceived chunk=$audioChunkCount data.size =  ${data.size} offset=$offset length=$length")
                        val safeOffset = if (offset in 0 until data.size) offset else 0
                        val maxAvailable = data.size - safeOffset
                        val safeLength = when {
                            length in 1..maxAvailable -> length
                            maxAvailable > 0 -> maxAvailable
                            else -> data.size
                        }
                        if (safeLength <= 0) {
                            Log.w(
                                tag,
                                "onAudioReceived invalid range. dataSize=${data.size} offset=$offset length=$length"
                            )
                            return@runCatching
                        }
                        output.write(data, safeOffset, safeLength)
                        pcmDataSize += safeLength
                        totalWrittenBytes += safeLength
                        if (audioChunkCount <= 3 || audioChunkCount % 20L == 0L) {
                            output.flush()
                        }
                    }.onFailure {
                        Log.e(tag, "write pcm failed. offset=$offset length=$length", it)
                    }
                } ?: run {
                    Log.w(tag, "onAudioReceived but pcmOutputStream is null")
                }
            }
            if (audioChunkCount <= 3 || audioChunkCount % 50L == 0L) {
                Log.d(
                    tag,
                    "onAudioReceived chunk=$audioChunkCount length=$length totalPcmBytes=$pcmDataSize totalWrittenBytes=$totalWrittenBytes"
                )
            }
        }

        override fun onAudioError(errorCode: Int, errorInfo: String?) {
            Log.e(tag, "onAudioError code=$errorCode info=${errorInfo ?: ""}")
            _audioStarted.value = false
            _status.value = tr(R.string.audio_error, errorCode, errorInfo ?: "")
        }

        override fun onAudioStreamStateChanged(started: Boolean) {
            Log.d(tag, "onAudioStreamStateChanged started=$started")
            _audioStarted.value = started
            _status.value = when {
                started && showAiInterruptStatusOnStreamStart -> {
                    showAiInterruptStatusOnStreamStart = false
                    tr(R.string.audio_ai_interrupt_start_recording)
                }
                started -> tr(R.string.audio_monitoring)
                else -> tr(R.string.audio_monitor_stopped)
            }
        }
    }

    /**
     * Initializes page state and binds global connection.
     *
     * @param context Used to access Application and storage directories.
     * @param token Authorization token. Missing token keeps page in non-operable state.
     * @param entryType Source entry for customApp/customView differentiation.
     */
    fun init(context: Context, token: String?, sessionType: CxrSessionType) {
        appContext = context.applicationContext
        _status.value = tr(R.string.audio_wait_start)
        _entryLabel.value = tr(sessionType.entryLabelRes)
        _recordDurationText.value = tr(R.string.audio_duration, 0.0)
        _audioFileCountText.value = tr(R.string.audio_file_count, 0)
        _recentAudioFilesText.value = tr(R.string.audio_recent_none)
        entryTypeValue = sessionType.wireValue
        _tokenGot.value = !token.isNullOrBlank()
        refreshAudioFileCount()
        if (!_tokenGot.value) {
            return
        }
        val app = context.applicationContext as? CXRLApplication
        if (app?.sharedLink == null || !app.isSessionReady) {
            _ready.value = false
            _status.value = tr(R.string.audio_need_connection)
            return
        }
        cxrLink = app.requireReadyLink()
        cxrLink.setCXRAudioCbk(audioCallback)
        observeConnectionFromHub()
        observeGlassAiInterrupt()
        Log.d(tag, "init finished. entryType=$entryTypeValue tokenGot=${_tokenGot.value}")
        refreshGlassPermission()
        _status.value = if (_permissionGranted.value) {
            tr(R.string.audio_reuse_connection_wait_start)
        } else {
            tr(R.string.audio_no_microphone_permission)
        }
    }

    private fun refreshGlassPermission() {
        _permissionGranted.value = AuthorizationHelper.hasGlassPermission(GlassPermission.MICROPHONE)
    }

    private fun resolveOperationalStatus(connected: Boolean): String = when {
        !_permissionGranted.value -> tr(R.string.audio_no_microphone_permission)
        connected -> tr(R.string.audio_connected_wait_start)
        else -> tr(R.string.common_service_not_connected)
    }

    private fun observeConnectionFromHub() {
        viewModelScope.launch {
            CxrLinkConnectionHub.cxrlConnected.collect { connected ->
                refreshGlassPermission()
                _ready.value = connected && _permissionGranted.value
                _status.value = resolveOperationalStatus(connected)
            }
        }
        viewModelScope.launch {
            CxrLinkConnectionHub.btConnected.collect { connected ->
                if (!connected) {
                    _ready.value = false
                    _status.value = tr(R.string.common_bt_not_connected)
                }
            }
        }
    }

    private fun observeGlassAiInterrupt() {
        viewModelScope.launch {
            CxrLinkConnectionHub.glassAiInterrupt.collect { interruptWake ->
                Log.d(tag, "onGlassAiInterrupt interruptWake=$interruptWake")
                if (_audioStarted.value) {
                    _status.value = tr(R.string.audio_ai_interrupt_start_recording)
                    return@collect
                }
                startAudio(triggeredByAiInterrupt = true)
            }
        }
    }

    /**
     * Starts audio monitoring and local PCM saving.
     */
    fun startAudio(triggeredByAiInterrupt: Boolean = false) {
        refreshGlassPermission()
        if (!_permissionGranted.value) {
            _audioStarted.value = false
            _status.value = tr(R.string.audio_no_microphone_permission)
            Log.e(tag, "startAudio: Permission Denied")
            return
        }
        if (!::cxrLink.isInitialized || !_ready.value) {
            Log.w(tag, "startAudio ignored. linkInitialized=${::cxrLink.isInitialized} ready=${_ready.value}")
            return
        }
        audioChunkCount = 0
        firstAudioChunkAtMs = 0L
        totalWrittenBytes = 0L
        showAiInterruptStatusOnStreamStart = triggeredByAiInterrupt
        startSavingPcm()
        val result = cxrLink.startAudioStream(1)
        Log.d(tag, "startAudio requested. result=$result triggeredByAiInterrupt=$triggeredByAiInterrupt")
        Log.d(tag, "startAudio requested. codecType=1 pcmFile=${pcmFile?.absolutePath}")
        _audioStarted.value = true
        _status.value = if (triggeredByAiInterrupt) {
            tr(R.string.audio_ai_interrupt_start_recording)
        } else {
            tr(R.string.audio_monitoring)
        }
        _hasPlayableAudio.value = false
    }

    /**
     * Stops monitoring and converts PCM to WAV.
     */
    fun stopAudio() {
        if (!::cxrLink.isInitialized || !_ready.value) {
            Log.w(tag, "stopAudio ignored. linkInitialized=${::cxrLink.isInitialized} ready=${_ready.value}")
            return
        }
        cxrLink.stopAudioStream()
        _audioStarted.value = false
        val hasFile = stopSavingAndBuildWav()
        Log.d(
            tag,
            "stopAudio summary: chunkCount=$audioChunkCount totalPcmBytes=$pcmDataSize totalWrittenBytes=$totalWrittenBytes hasFile=$hasFile wav=${wavFile?.absolutePath}"
        )
        _status.value = if (hasFile) {
            tr(R.string.audio_stopped_saved)
        } else {
            tr(R.string.audio_stopped_no_data)
        }
    }

    /**
     * Toggles playback state for saved audio.
     */
    fun togglePlaySavedAudio() {
        if (_isPlaying.value) {
            stopPlayback()
            return
        }
        val playFile = wavFile
        if (playFile == null || !playFile.exists()) return
        stopPlayback()
        mediaPlayer = MediaPlayer().apply {
            setDataSource(playFile.absolutePath)
            prepare()
            setOnCompletionListener {
                _isPlaying.value = false
                _status.value = tr(R.string.audio_playback_finished)
                release()
                mediaPlayer = null
            }
            start()
        }
        _isPlaying.value = true
        _status.value = tr(R.string.audio_playback_running)
    }

    private fun stopPlayback() {
        mediaPlayer?.runCatching {
            if (isPlaying) stop()
            reset()
            release()
        }
        mediaPlayer = null
        _isPlaying.value = false
    }

    /**
     * Creates PCM/WAV files for current recording and opens PCM output stream.
     */
    private fun startSavingPcm() {
        val baseDir = appContext?.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
            ?: appContext?.filesDir
            ?: return
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val prefix = if (entryTypeValue == CONSTANT.ENTRY_TYPE_CUSTOM_VIEW) "customView" else "customApp"
        val tempPcm = File(baseDir, "${prefix}_$timestamp.pcm")
        synchronized(fileLock) {
            runCatching { pcmOutputStream?.close() }
            pcmFile = tempPcm
            wavFile = File(baseDir, "${prefix}_$timestamp.wav")
            pcmOutputStream = FileOutputStream(tempPcm, false)
            pcmDataSize = 0L
            totalWrittenBytes = 0L
        }
        Log.d(tag, "startSavingPcm: pcm=${pcmFile?.absolutePath}, wav=${wavFile?.absolutePath}")
    }

    /**
     * Finishes PCM writing and attempts to build WAV file.
     *
     * @return Whether a playable WAV file is produced.
     */
    private fun stopSavingAndBuildWav(): Boolean {
        val localPcmFile: File
        val localWavFile: File
        val localPcmDataSize: Long
        synchronized(fileLock) {
            runCatching {
                pcmOutputStream?.flush()
                pcmOutputStream?.fd?.sync()
            }.onFailure {
                Log.w(tag, "flush/sync pcm failed", it)
            }
            runCatching { pcmOutputStream?.close() }
            pcmOutputStream = null
            localPcmFile = pcmFile ?: return false
            localWavFile = wavFile ?: return false
            localPcmDataSize = pcmDataSize
        }
        if (!localPcmFile.exists()) {
            Log.w(
                tag,
                "stopSavingAndBuildWav failed: pcm file not exists. path=${localPcmFile.absolutePath}"
            )
            _hasPlayableAudio.value = false
            _savedAudioPath.value = ""
            _recordDurationText.value = tr(R.string.audio_duration, 0.0)
            refreshAudioFileCount()
            return false
        }
        // On some devices callback counters can lag, so fallback to actual file size.
        val actualPcmSize = if (localPcmDataSize > 0) localPcmDataSize else localPcmFile.length()
        Log.d(
            tag,
            "stopSavingAndBuildWav source size: bytesByCounter=$localPcmDataSize bytesByFile=${localPcmFile.length()} totalWrittenBytes=$totalWrittenBytes chunkCount=$audioChunkCount"
        )
        if (actualPcmSize <= 0) {
            Log.w(
                tag,
                "stopSavingAndBuildWav no valid pcm data. bytesByCounter=$localPcmDataSize bytesByFile=${localPcmFile.length()} chunkCount=$audioChunkCount"
            )
            _hasPlayableAudio.value = false
            _savedAudioPath.value = ""
            _recordDurationText.value = tr(R.string.audio_duration, 0.0)
            refreshAudioFileCount()
            return false
        }
        runCatching {
            buildWavFromPcm(localPcmFile, localWavFile, actualPcmSize)
        }.onFailure {
            Log.e(
                tag,
                "buildWavFromPcm exception. pcm=${localPcmFile.absolutePath} wav=${localWavFile.absolutePath} pcmBytes=$actualPcmSize",
                it
            )
            _hasPlayableAudio.value = false
            _savedAudioPath.value = ""
            _recordDurationText.value = tr(R.string.audio_duration, 0.0)
            refreshAudioFileCount()
            return false
        }
        _hasPlayableAudio.value = localWavFile.exists() && localWavFile.length() > 44
        Log.d(
            tag,
            "buildWavFromPcm finished. pcmBytes=$actualPcmSize wavBytes=${localWavFile.length()} wavPath=${localWavFile.absolutePath}"
        )
        if (_hasPlayableAudio.value) {
            _savedAudioPath.value = localWavFile.absolutePath
            val durationSeconds = actualPcmSize.toDouble() / (16000.0 * 2.0)
            _recordDurationText.value = tr(R.string.audio_duration, durationSeconds)
        } else {
            _savedAudioPath.value = ""
            _recordDurationText.value = tr(R.string.audio_duration, 0.0)
        }
        refreshAudioFileCount()
        return _hasPlayableAudio.value
    }

    /**
     * Converts PCM file into WAV file.
     */
    private fun buildWavFromPcm(pcm: File, wav: File, pcmSize: Long) {
        val sampleRate = 16_000
        val channels: Short = 1
        val bitsPerSample: Short = 16
        val byteRate = sampleRate * channels * bitsPerSample / 8
        FileOutputStream(wav, false).use { wavOut ->
            writeWavHeader(
                out = wavOut,
                totalAudioLen = pcmSize,
                sampleRate = sampleRate,
                channels = channels,
                bitsPerSample = bitsPerSample,
                byteRate = byteRate
            )
            FileInputStream(pcm).use { pcmIn ->
                val buffer = ByteArray(4096)
                var read = pcmIn.read(buffer)
                while (read > 0) {
                    wavOut.write(buffer, 0, read)
                    read = pcmIn.read(buffer)
                }
            }
        }
    }

    /**
     * Writes standard 44-byte WAV header.
     */
    private fun writeWavHeader(
        out: FileOutputStream,
        totalAudioLen: Long,
        sampleRate: Int,
        channels: Short,
        bitsPerSample: Short,
        byteRate: Int
    ) {
        val totalDataLen = totalAudioLen + 36
        val header = ByteArray(44)
        header[0] = 'R'.code.toByte()
        header[1] = 'I'.code.toByte()
        header[2] = 'F'.code.toByte()
        header[3] = 'F'.code.toByte()
        header[4] = (totalDataLen and 0xff).toByte()
        header[5] = ((totalDataLen shr 8) and 0xff).toByte()
        header[6] = ((totalDataLen shr 16) and 0xff).toByte()
        header[7] = ((totalDataLen shr 24) and 0xff).toByte()
        header[8] = 'W'.code.toByte()
        header[9] = 'A'.code.toByte()
        header[10] = 'V'.code.toByte()
        header[11] = 'E'.code.toByte()
        header[12] = 'f'.code.toByte()
        header[13] = 'm'.code.toByte()
        header[14] = 't'.code.toByte()
        header[15] = ' '.code.toByte()
        header[16] = 16
        header[17] = 0
        header[18] = 0
        header[19] = 0
        header[20] = 1
        header[21] = 0
        header[22] = channels.toByte()
        header[23] = 0
        header[24] = (sampleRate and 0xff).toByte()
        header[25] = ((sampleRate shr 8) and 0xff).toByte()
        header[26] = ((sampleRate shr 16) and 0xff).toByte()
        header[27] = ((sampleRate shr 24) and 0xff).toByte()
        header[28] = (byteRate and 0xff).toByte()
        header[29] = ((byteRate shr 8) and 0xff).toByte()
        header[30] = ((byteRate shr 16) and 0xff).toByte()
        header[31] = ((byteRate shr 24) and 0xff).toByte()
        header[32] = ((channels * bitsPerSample / 8) and 0xff).toByte()
        header[33] = 0
        header[34] = bitsPerSample.toByte()
        header[35] = 0
        header[36] = 'd'.code.toByte()
        header[37] = 'a'.code.toByte()
        header[38] = 't'.code.toByte()
        header[39] = 'a'.code.toByte()
        header[40] = (totalAudioLen and 0xff).toByte()
        header[41] = ((totalAudioLen shr 8) and 0xff).toByte()
        header[42] = ((totalAudioLen shr 16) and 0xff).toByte()
        header[43] = ((totalAudioLen shr 24) and 0xff).toByte()
        out.write(header, 0, 44)
    }

    /**
     * Releases audio resources when page is destroyed (stops stream; SDK callbacks are non-null).
     */
    fun release() {
        if (::cxrLink.isInitialized) {
            runCatching { cxrLink.stopAudioStream() }
        }
        stopSavingAndBuildWav()
        stopPlayback()
        _audioStarted.value = false
    }

    /**
     * Cleans history audio files while keeping latest N records.
     */
    fun clearHistoryAudioFiles(keepLatestCount: Int = 3) {
        val baseDir = appContext?.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
            ?: appContext?.filesDir
            ?: run {
                _cleanupResult.value = tr(R.string.audio_cleanup_failed_no_dir)
                return
            }
        val files = baseDir.listFiles().orEmpty().filter {
            it.isFile && (it.name.endsWith(".wav") || it.name.endsWith(".pcm"))
        }.sortedByDescending { it.lastModified() }

        val protectedFiles = files.take(keepLatestCount).toSet()
        var success = 0
        var failed = 0
        files.forEach { file ->
            if (file == wavFile || file == pcmFile || protectedFiles.contains(file)) {
                return@forEach
            }
            if (file.delete()) success++ else failed++
        }
        _cleanupResult.value = tr(R.string.audio_cleanup_result, keepLatestCount, success, failed)
        refreshAudioFileCount()
    }

    /**
     * Refreshes audio file metrics and recent file list text.
     */
    private fun refreshAudioFileCount() {
        val baseDir = appContext?.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
            ?: appContext?.filesDir
            ?: run {
                _audioFileCountText.value = tr(R.string.audio_file_count, 0)
                _recentAudioFilesText.value = tr(R.string.audio_recent_none)
                return
            }
        val audioFiles = baseDir.listFiles().orEmpty().filter {
            it.isFile && (it.name.endsWith(".wav") || it.name.endsWith(".pcm"))
        }.sortedByDescending { it.lastModified() }
        val count = audioFiles.size
        _audioFileCountText.value = tr(R.string.audio_file_count, count)
        if (audioFiles.isEmpty()) {
            _recentAudioFilesText.value = tr(R.string.audio_recent_none)
            return
        }
        val sdf = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())
        val lines = audioFiles.take(3).joinToString("\n") { file ->
            "${file.name} (${sdf.format(Date(file.lastModified()))})"
        }
        _recentAudioFilesText.value = tr(R.string.audio_recent_top3, lines)
    }

    /**
     * Builds a system share Intent for WAV file.
     */
    fun buildShareIntent(context: Context): Intent? {
        val file = wavFile
        if (file == null || !file.exists()) return null
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        return Intent(Intent.ACTION_SEND).apply {
            type = "audio/wav"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    private fun tr(@StringRes resId: Int, vararg args: Any): String {
        val context = appContext ?: return ""
        return context.getString(resId, *args)
    }
}