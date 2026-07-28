package com.rokid.renewcxrlsample.dataBean.selfView


/**
 * Lottie repeat mode enum.
 */
enum class LottieRepeatMode(val str: String) {
    RESTART("restart"), REVERSE("reverse")
}

/**
 * Lottie animation node property model.
 */
class LottieAnimProps {
    var id: String = ""
        set(value) {
            field = if (value.matches(Regex("[a-zA-Z0-9_]+"))) {
                value
            } else {
                throw IllegalArgumentException("id must be a valid identifier")
            }
        }
    var layout_width: String = "match_parent"
        set(value) {
            field =
                if (value == "match_parent" || value == "wrap_content" || value.endsWith("dp")) {
                    value
                } else if (value.matches(Regex("\\d+"))) {
                    // If only a number is provided, append dp automatically.
                    "${value}dp"
                } else {
                    throw IllegalArgumentException("layout_width must be 'match_parent', 'wrap_content', or a value ending with 'dp'")
                }
        }
    var layout_height: String = "wrap_content"
        set(value) {
            field =
                if (value == "match_parent" || value == "wrap_content" || value.endsWith("dp")) {
                    value
                } else if (value.matches(Regex("\\d+"))) {
                    // If only a number is provided, append dp automatically.
                    "${value}dp"
                } else {
                    throw IllegalArgumentException("layout_height must be 'match_parent', 'wrap_content', or a value ending with 'dp'")
                }
        }

    var autoPlay: Boolean = true
    var loop: Boolean = false
    var repeatCount = 1
    var repeatMode = LottieRepeatMode.RESTART.str
    var speed = 1.0f
    var progress = 0.0f
        set(value) {
            field = if (value > 0 && value <= 1) {
                value
            } else {
                if (value <= 0f) 0f else 1.0f
            }
        }
    var scale = 1.0f

    /**
     * Serializes into `props` JSON used by custom-view protocol.
     */
    fun toJson(): String {
        return if (id.isEmpty()) {
            throw IllegalArgumentException("id can not be empty")
        } else {
            val sb: StringBuilder = StringBuilder("{")
                .append("\"id\":\"$id\"")
                .append(",\"layout_width\":\"$layout_width\"")
                .append(",\"layout_height\":\"$layout_height\"")
                .append(",\"app:lottie_autoPlay\":\"$autoPlay\"")
                .append(",\"app:lottie_loop\":\"$loop\"")
                .append(",\"app:lottie_repeatCount\":$repeatCount")
                .append(",\"app:lottie_repeatMode\":$repeatMode")
                .append(",\"app:lottie_speed\":$speed")
                .append(",\"app:lottie_scale\":$scale")
            if (progress > 0.0f && progress <= 1.0f){
                sb.append(",\"app:lottie_progress\":$progress")
            }
            sb.append("}").toString()
        }
    }
}