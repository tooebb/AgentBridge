package com.rokid.cxrswithcxrl.agent

import android.content.Context
import android.speech.tts.TextToSpeech
import android.util.Log
import com.rokid.cxrswithcxrl.receiver.KeyType
import java.util.Locale

class AgentActionHandler(
    context: Context,
    private val actionSender: (taskId: String, actionType: String) -> Boolean
) : TextToSpeech.OnInitListener {
    private val appContext = context.applicationContext
    private var textToSpeech: TextToSpeech? = TextToSpeech(appContext, this)
    private var ttsReady = false
    private var currentState = AgentCardState()

    override fun onInit(status: Int) {
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) {
            textToSpeech?.language = Locale.CHINA
        }
    }

    fun reduce(message: DeviceMessage, duplicate: Boolean): AgentCardState {
        if (duplicate) {
            currentState = currentState.copy(
                duplicateCount = currentState.duplicateCount + 1,
                statusLine = "duplicate ignored, lastAckedSeq=${currentState.lastAckedSeq}"
            )
            return currentState
        }

        val event = message.event
        val output = message.deviceOverrides?.get(DEVICE_TYPE_AR_GLASSES)
        val fallbackActions = event?.availableActions?.mapNotNull { it.actionType.takeIf(String::isNotBlank) }.orEmpty()
        val quickActions = if (event?.riskBlocked == true) {
            listOf("view_details")
        } else {
            output?.quickActions?.takeIf { it.isNotEmpty() } ?: fallbackActions
        }
        val title = output?.cardTitle?.takeIf { it.isNotBlank() } ?: event?.title ?: "AgentBridge"
        val baseBody = output?.cardBody?.takeIf { it.isNotBlank() } ?: event?.body ?: ""
        val body = if (event?.riskBlocked == true) {
            "High risk action blocked on glasses. Return to PC to confirm.\n$baseBody"
        } else {
            baseBody
        }
        val renderHint = output?.renderHint?.takeIf { it.isNotBlank() } ?: renderHintFor(event?.eventType, event?.severity)
        val severity = event?.severity ?: currentState.severity
        val statusLine = "seq=${message.seq}, replay=${message.isReplay}, event=${event?.eventType ?: "unknown"}"

        currentState = AgentCardState(
            connectionLabel = currentState.connectionLabel,
            title = title,
            body = body,
            renderHint = renderHint,
            severity = severity,
            taskId = event?.taskId.orEmpty(),
            quickActions = quickActions,
            lastAckedSeq = message.seq.coerceAtLeast(currentState.lastAckedSeq),
            isReplay = message.isReplay,
            duplicateCount = currentState.duplicateCount,
            statusLine = statusLine
        )

        val ttsText = if (event?.riskBlocked == true) {
            "高风险操作需要回到电脑确认"
        } else {
            output?.ttsText?.takeIf { it.isNotBlank() } ?: title
        }
        if (!message.isReplay && ttsText.isNotBlank()) {
            speak(ttsText)
        }
        return currentState
    }

    fun onConnectionChanged(label: String): AgentCardState {
        currentState = currentState.copy(connectionLabel = label)
        return currentState
    }

    fun onKey(keyType: KeyType): AgentCardState {
        val action = when (keyType) {
            KeyType.CLICK -> pickAction(0) ?: "continue"
            KeyType.DOUBLE_CLICK -> pickAction(1) ?: "pause"
            KeyType.LONG_PRESS -> "view_details"
            KeyType.ACTION_TWO_FINGER_SINGLE_TAP -> pickAction(0) ?: "continue"
            KeyType.ACTION_TWO_FINGER_DOUBLE_TAP -> pickAction(1) ?: "pause"
            KeyType.ACTION_TWO_FINGER_SWIPE_FORWARD -> "continue"
            KeyType.ACTION_TWO_FINGER_SWIPE_BACK -> "pause"
            else -> null
        }
        if (action == null) {
            return currentState
        }

        val sent = actionSender(currentState.taskId, action)
        currentState = currentState.copy(
            statusLine = if (sent) {
                "sent action=$action, lastAckedSeq=${currentState.lastAckedSeq}"
            } else {
                "action=$action not sent"
            }
        )
        return currentState
    }

    fun onGestureResult(actionType: String, sent: Boolean): AgentCardState {
        currentState = currentState.copy(
            statusLine = if (sent) {
                "sent action=$actionType, lastAckedSeq=${currentState.lastAckedSeq}"
            } else {
                "action=$actionType not sent"
            }
        )
        return currentState
    }

    fun close() {
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
    }

    private fun pickAction(index: Int): String? = currentState.quickActions.getOrNull(index)

    private fun speak(text: String) {
        if (!ttsReady) {
            Log.d(TAG, "TTS not ready: $text")
            return
        }
        textToSpeech?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "agentbridge-${System.currentTimeMillis()}")
    }

    private fun renderHintFor(eventType: String?, severity: String?): String {
        return when {
            eventType == "needs_approval" -> "actionable_card"
            severity == "critical" -> "alert_card"
            else -> "status_card"
        }
    }

    companion object {
        private const val TAG = "AgentActionHandler"
    }
}
