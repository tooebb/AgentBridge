package com.rokid.cxrswithcxrl.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun AgentBridgeScreen(card: AgentCardState, capsFromClient: String, debugStatus: String = "") {
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
        color = Color.Black
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.Center
        ) {
            ConnectionHeader(card)
            if (debugStatus.isNotBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = debugStatus,
                    color = Color(0xFFF4B400),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(modifier = Modifier.height(12.dp))
            AgentCard(card)
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = capsFromClient,
                color = Color(0xFF8FBF8F),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun ConnectionHeader(card: AgentCardState) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = card.connectionLabel,
            color = Color(0xFFB9FBC0),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Text(
            text = "ack=${card.lastAckedSeq}",
            color = Color(0xFF9AA0A6),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1
        )
    }
}

@Composable
private fun AgentCard(card: AgentCardState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor(card))
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = card.title,
                color = Color.White,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = card.body,
                color = Color(0xFFE8EAED),
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = actionHint(card),
                color = Color(0xFFB9FBC0),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = card.statusLine,
                color = Color(0xFFBDC1C6),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

private fun containerColor(card: AgentCardState): Color {
    return when {
        card.renderHint == "alert_card" || card.severity == "critical" -> Color(0xFF6D2932)
        card.renderHint == "actionable_card" -> Color(0xFF224C3A)
        card.severity == "warning" -> Color(0xFF5C4A1F)
        else -> Color(0xFF1F2933)
    }
}

private fun actionHint(card: AgentCardState): String {
    val click = card.quickActions.getOrNull(0) ?: "continue"
    val doubleClick = card.quickActions.getOrNull(1) ?: "pause"
    return "CLICK: $click    DOUBLE: $doubleClick    LONG: view_details"
}
