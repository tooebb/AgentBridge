package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardStateMachineTest {

    private fun approvalMessage(details: String = "Command: rm foo\nTool input: {...}"): DeviceMessage =
        DeviceMessage(
            messageId = "m1",
            sessionId = "default",
            seq = 1,
            event = UnifiedMessage(
                taskId = "default",
                eventType = "needs_approval",
                title = "Approval required: Write",
                body = "Risk score: 0.4",
                details = details,
            ),
            deviceOverrides = mapOf(
                DEVICE_TYPE_AR_GLASSES to DeviceOutput(
                    cardTitle = "⛔ 审批: Approval required: Write",
                    cardBody = "风险: 40% | Risk score: 0.4",
                    cardDetails = details,
                    quickActions = listOf("approve", "reject"),
                    renderHint = "actionable_card",
                )
            )
        )

    private fun statusMessage(seq: Long, eventType: String, title: String, body: String) = DeviceMessage(
        messageId = "m$seq",
        sessionId = "default",
        seq = seq,
        event = UnifiedMessage(taskId = "default", eventType = eventType, title = title, body = body),
        deviceOverrides = mapOf(
            DEVICE_TYPE_AR_GLASSES to DeviceOutput(cardTitle = title, cardBody = body, renderHint = "status_card")
        )
    )

    @Test
    fun reduce_setsActionableCard_withEmptyDecision() {
        val result = CardStateMachine.reduce(AgentCardState(), approvalMessage(), duplicate = false)
        assertEquals("actionable_card", result.state.renderHint)
        assertEquals("", result.state.decision)
        assertEquals("Command: rm foo\nTool input: {...}", result.state.details)
    }

    @Test
    fun reduce_preservesActionableCard_whenStatusEventArrivesBeforeDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val result = CardStateMachine.reduce(approval, statusMessage(2, "task_running", "◉ Agent output", "working"), false)
        assertEquals("actionable_card", result.state.renderHint)
    }

    @Test
    fun reduce_allowsTaskRunningAfterDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val decided = CardStateMachine.onDecision(approval, "approve")
        assertEquals("executing_card", decided.renderHint)
        val result = CardStateMachine.reduce(decided, statusMessage(3, "task_running", "◉ Agent output", "writing..."), false)
        assertEquals("status_card", result.state.renderHint)
        assertEquals("approve", result.state.decision)
    }

    @Test
    fun reduce_allowsTaskCompletedWithoutDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val result = CardStateMachine.reduce(approval, statusMessage(4, "task_completed", "✓ Task completed", "done"), false)
        assertEquals("status_card", result.state.renderHint)
    }

    @Test
    fun onDecision_rejectProducesRejectedCard() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val rejected = CardStateMachine.onDecision(approval, "reject")
        assertEquals("rejected_card", rejected.renderHint)
        assertEquals("reject", rejected.decision)
    }

    @Test
    fun onViewDetails_togglesDetailsVisible() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        assertFalse(approval.detailsVisible)
        assertTrue(CardStateMachine.onViewDetails(approval).detailsVisible)
        assertFalse(CardStateMachine.onViewDetails(CardStateMachine.onViewDetails(approval)).detailsVisible)
    }

    @Test
    fun onViewDetails_noopWhenDetailsEmpty() {
        assertFalse(CardStateMachine.onViewDetails(AgentCardState(details = "")).detailsVisible)
    }
}
