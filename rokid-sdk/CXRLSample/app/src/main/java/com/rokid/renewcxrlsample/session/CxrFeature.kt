package com.rokid.renewcxrlsample.session

import androidx.annotation.StringRes
import com.rokid.renewcxrlsample.R

enum class CxrFeature(@StringRes val labelRes: Int, val route: String) {
    AUDIO(R.string.screen_title_audio, SceneRoutes.AUDIO),
    PHOTO(R.string.screen_title_photo, SceneRoutes.PHOTO),
    CUSTOM_CMD(R.string.screen_title_custom_cmd, SceneRoutes.CMD),
    DEVICE_CONTROL(R.string.device_control, SceneRoutes.DEVICE_CONTROL),
}
