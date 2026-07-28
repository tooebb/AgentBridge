package com.rokid.renewcxrlsample.dataBean.selfView

/**
 * ImageView node property model.
 *
 * Validates fields and outputs `props` JSON required by protocol.
 */
class ImageViewProps {
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
    var name: String = "NONE"

    var scaleType: String = "center"
        set(value) {
            field = when (value) {
                "center", "center_crop", "center_inside", "fit_center", "fit_end", "fit_start", "fit_xy", "matrix" -> value
                else -> throw IllegalArgumentException("scaleType must be one of center, center_crop, center_inside, fit_center, fit_end, fit_start, fit_xy, matrix")
            }
        }

    /**
     * Processes color value and keeps only green channel if format is valid.
     */
    private fun processColorValue(color: String): String {
        // Check valid ARGB format (#AARRGGBB).
        if (color.matches(Regex("#[0-9a-fA-F]{8}"))) {
            // Parse ARGB channels.
            val alpha = color.substring(1, 3)
            val red = color.substring(3, 5)
            val green = color.substring(5, 7)
            val blue = color.substring(7, 9)

            // Return color with green channel only; red and blue channels become 00.
            return "#$alpha${"00"}$green${"00"}"
        }
        // Check valid RGB format (#RRGGBB).
        else if (color.matches(Regex("#[0-9a-fA-F]{6}"))) {
            // Parse RGB channels.
            val red = color.substring(1, 3)
            val green = color.substring(3, 5)
            val blue = color.substring(5, 7)

            // Return color with green channel only; red and blue channels become 00.
            return "#FF${"00"}$green${"00"}"
        }
        // Return original input if format is invalid.
        else {
            return color
        }
    }

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
                .append(",\"name\":\"$name\"")
                .append(",\"scaleType\":\"$scaleType\"")
            sb.append("}").toString()
        }
    }
}