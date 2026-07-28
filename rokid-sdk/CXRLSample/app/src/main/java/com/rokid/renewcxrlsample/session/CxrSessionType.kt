package com.rokid.renewcxrlsample.session

import androidx.annotation.StringRes
import com.rokid.renewcxrlsample.R
import com.rokid.renewcxrlsample.app.CONSTANT

enum class CxrSessionType(val wireValue: String, @StringRes val entryLabelRes: Int) {
    CUSTOM_VIEW(CONSTANT.SESSION_TYPE_CUSTOM_VIEW, R.string.session_entry_custom_view),
    CUSTOM_APP(CONSTANT.SESSION_TYPE_CUSTOM_APP, R.string.session_entry_custom_app);

    companion object {
        fun fromWire(value: String?): CxrSessionType? = entries.find { it.wireValue == value }

        fun fromIntentExtra(value: String?): CxrSessionType {
            return fromWire(value)
                ?: fromLegacyEntryType(value)
                ?: CUSTOM_APP
        }

        private fun fromLegacyEntryType(value: String?): CxrSessionType? = when (value) {
            CONSTANT.ENTRY_TYPE_CUSTOM_VIEW -> CUSTOM_VIEW
            CONSTANT.ENTRY_TYPE_CUSTOM_APP -> CUSTOM_APP
            else -> null
        }
    }
}
