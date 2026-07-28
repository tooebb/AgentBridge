package com.rokid.renewcxrlsample.dataBean.selfView

import kotlin.collections.iterator

/**
 * Custom-view update protocol model.
 *
 * Describes one or multiple node delta updates in a single request.
 */
class UpdateViewJson {
    // A single update call can carry incremental updates for multiple nodes.
    val updateList = mutableListOf<UpdateJson>()
    /**
     * Update item for a single node.
     *
     * @property id Target node id.
     */
    class UpdateJson(val id: String){
        // This sample only uses "update", distinct from open/close actions.
        val action = "update"
        // Include changed fields only to avoid re-sending full node payload.
        var props: HashMap<String, String> = HashMap()
    }

    /**
     * Serializes to update JSON array required by SDK.
     */
    fun toJson(): String {
        // Output format: [{"action":"update","id":"textView","props":{"text":"..."}}]
        val sb: StringBuilder = StringBuilder("[")

        for (update in updateList) {
            sb.append("{")
            sb.append("\"action\":\"${update.action}\",")
            sb.append("\"id\":\"${update.id}\",")
            sb.append("\"props\":{")

            for ((key, value) in update.props) {
                sb.append("\"$key\":\"$value\",")
            }

            sb.deleteCharAt(sb.length - 1)
            sb.append("}")
            sb.append("},")
        }
        sb.deleteCharAt(sb.length - 1)

        sb.append("]")
        return sb.toString()
    }
}