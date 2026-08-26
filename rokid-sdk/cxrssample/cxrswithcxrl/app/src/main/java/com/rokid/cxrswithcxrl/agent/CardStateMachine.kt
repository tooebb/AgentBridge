package com.rokid.cxrswithcxrl.agent

object CardStateMachine {

    data class Reduction(val state: AgentCardState, val ttsText: String)

    private val cardPreservedEvents = setOf("task_started", "task_running", "heartbeat")

    fun reduce(current: AgentCardState, message: DeviceMessage, duplicate: Boolean): Reduction {
        if (duplicate) {
            return Reduction(
                current.copy(
                    duplicateCount = current.duplicateCount + 1,
                    statusLine = "duplicate ignored, lastAckedSeq=${current.lastAckedSeq}"
                ),
                ""
            )
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
        val details = output?.cardDetails?.takeIf { it.isNotBlank() } ?: event?.details ?: ""

        if (current.renderHint == "actionable_card"
            && current.decision.isEmpty()
            && event?.eventType != "task_completed"
            && (renderHint == "status_card" || event?.eventType in cardPreservedEvents)
        ) {
            return Reduction(
                current.copy(
                    lastAckedSeq = message.seq.coerceAtLeast(current.lastAckedSeq),
                    statusLine = "seq=${message.seq}, replay=${message.isReplay}, card preserved"
                ),
                ""
            )
        }

        val severity = event?.severity ?: current.severity
        val newState = AgentCardState(
            connectionLabel = current.connectionLabel,
            title = title,
            body = body,
            renderHint = renderHint,
            severity = severity,
            taskId = event?.taskId.orEmpty(),
            decision = if (event?.eventType == "needs_approval") "" else current.decision,
            details = details,
            detailsVisible = if (event?.eventType == "needs_approval") false else current.detailsVisible,
            quickActions = quickActions,
            lastAckedSeq = message.seq.coerceAtLeast(current.lastAckedSeq),
            isReplay = message.isReplay,
            duplicateCount = current.duplicateCount,
            screenOff = if (event?.eventType == "heartbeat") current.screenOff else false,
            statusLine = "seq=${message.seq}, replay=${message.isReplay}, event=${event?.eventType ?: "unknown"}"
        )

        val ttsText = if (event?.riskBlocked == true) {
            "高风险操作需要回到电脑确认"
        } else {
            output?.ttsText?.takeIf { it.isNotBlank() } ?: title
        }

        return Reduction(newState, ttsText)
    }

    fun onDecision(current: AgentCardState, action: String): AgentCardState {
        if (current.renderHint != "actionable_card" || current.decision.isNotEmpty()) {
            return current
        }
        return when (action) {
            "approve" -> current.copy(
                renderHint = "executing_card",
                title = "⏳ 执行中",
                body = "已批准，等待 agent 输出…",
                quickActions = emptyList(),
                decision = "approve"
            )
            "reject" -> current.copy(
                renderHint = "rejected_card",
                title = "⛔ 已拒绝",
                body = "已拒绝该操作，等待 agent 回复…",
                quickActions = emptyList(),
                decision = "reject"
            )
            else -> current
        }
    }

    fun onViewDetails(current: AgentCardState): AgentCardState =
        current.copy(detailsVisible = !current.detailsVisible)

    fun resetToIdle(current: AgentCardState): AgentCardState =
        AgentCardState(connectionLabel = current.connectionLabel)

    fun shouldKeepScreenOn(state: AgentCardState): Boolean = !state.screenOff

    fun setScreenOff(current: AgentCardState, off: Boolean): AgentCardState =
        current.copy(screenOff = off)

    fun shouldRouteToApproval(state: AgentCardState): Boolean =
        state.renderHint == "actionable_card"

    fun renderHintFor(eventType: String?, severity: String?): String = when {
        eventType == "needs_approval" -> "actionable_card"
        severity == "critical" -> "alert_card"
        else -> "status_card"
    }
}
