package com.rokid.cxrswithcxrl.agent

import com.google.gson.annotations.SerializedName

const val DEVICE_TYPE_AR_GLASSES = "ar_glasses"

data class DeviceMessage(
    val direction: String = "",
    @SerializedName("message_id") val messageId: String = "",
    @SerializedName("session_id") val sessionId: String = "",
    val seq: Long = 0,
    @SerializedName("is_replay") val isReplay: Boolean = false,
    val timestamp: Long = 0,
    val event: UnifiedMessage? = null,
    @SerializedName("device_overrides") val deviceOverrides: Map<String, DeviceOutput>? = null
)

data class UnifiedMessage(
    val id: String = "",
    @SerializedName("task_id") val taskId: String = "",
    @SerializedName("session_id") val sessionId: String = "",
    @SerializedName("event_type") val eventType: String = "",
    val title: String = "",
    val body: String = "",
    @SerializedName("details") val details: String = "",
    val severity: String = "info",
    @SerializedName("risk_score") val riskScore: Double = 0.0,
    @SerializedName("risk_blocked") val riskBlocked: Boolean = false,
    @SerializedName("available_actions") val availableActions: List<AvailableAction> = emptyList(),
    val timestamp: String = "",
    @SerializedName("agent_id") val agentId: String = ""
)

data class AvailableAction(
    @SerializedName("action_type") val actionType: String = "",
    val label: String = "",
    @SerializedName("confirmation_required") val confirmationRequired: Boolean = false
)

data class DeviceOutput(
    @SerializedName("tts_text") val ttsText: String = "",
    @SerializedName("card_title") val cardTitle: String = "",
    @SerializedName("card_body") val cardBody: String = "",
    @SerializedName("card_details") val cardDetails: String = "",
    @SerializedName("quick_actions") val quickActions: List<String> = emptyList(),
    @SerializedName("vibe_pattern") val vibePattern: String = "",
    @SerializedName("render_hint") val renderHint: String = "card"
)

data class ClientMessage(
    val direction: String = "client_to_server",
    @SerializedName("session_id") val sessionId: String,
    @SerializedName("task_id") val taskId: String,
    @SerializedName("last_acked_seq") val lastAckedSeq: Long,
    val action: ClientAction
)

data class ClientAction(
    val type: String,
    @SerializedName("device_type") val deviceType: String = DEVICE_TYPE_AR_GLASSES,
    val timestamp: Long = System.currentTimeMillis(),
    val text: String = ""
)

data class AgentCardState(
    val connectionLabel: String = "WS: idle",
    val title: String = "AgentBridge",
    val body: String = "Waiting for middleware events",
    val renderHint: String = "status_card",
    val severity: String = "info",
    val taskId: String = "",
    val decision: String = "",
    val details: String = "",
    val detailsVisible: Boolean = false,
    val quickActions: List<String> = emptyList(),
    val lastAckedSeq: Long = 0,
    val isReplay: Boolean = false,
    val duplicateCount: Int = 0,
    val statusLine: String = "session=default",
    val screenOff: Boolean = false
)
