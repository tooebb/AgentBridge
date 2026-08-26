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
        val reduction = CardStateMachine.reduce(currentState, message, duplicate)
        currentState = reduction.state

        if (!message.isReplay && reduction.ttsText.isNotBlank()) {
            speak(reduction.ttsText)
        }
        return currentState
    }

    fun onConnectionChanged(label: String): AgentCardState {
        currentState = CardStateMachine.resetToIdle(currentState).copy(connectionLabel = label)
        return currentState
    }

    fun onKey(keyType: KeyType): AgentCardState {
        val action = when (keyType) {
            KeyType.CLICK -> pickAction(0) ?: "continue"
            KeyType.DOUBLE_CLICK -> pickAction(1) ?: "pause"
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
        if (sent) {
            currentState = CardStateMachine.onDecision(currentState, action)
        }
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
        if (sent) {
            currentState = when (actionType) {
                "view_details" -> CardStateMachine.onViewDetails(currentState)
                else -> CardStateMachine.onDecision(currentState, actionType)
            }
        }
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

    companion object {
        private const val TAG = "AgentActionHandler"
    }
}
