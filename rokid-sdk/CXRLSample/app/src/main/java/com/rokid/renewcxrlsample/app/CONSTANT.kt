package com.rokid.renewcxrlsample.app

object CONSTANT {
    const val REQUEST_CODE_AUTH = 1001

    /** Mainland China companion app (Rokid AI). */
    const val ROKID_AI_PACKAGE = "com.rokid.sprite.aiapp"

    /** International companion app (Hi Rokid). */
    const val HI_ROKID_PACKAGE = "com.rokid.sprite.global.aiapp"

    val APP_PACKAGE_NAME = "com.rokid.cxrswithcxrl"
    val MAIN_PAGE = ".activities.main.MainActivity"

    const val EXTRA_TOKEN = "token"
    const val EXTRA_SESSION_TYPE = "sessionType"
    const val EXTRA_ENTRY_TYPE = "entryType"
    const val SESSION_TYPE_CUSTOM_APP = "customApp"
    const val SESSION_TYPE_CUSTOM_VIEW = "customView"
    const val ENTRY_TYPE_CUSTOM_APP = SESSION_TYPE_CUSTOM_APP
    const val ENTRY_TYPE_CUSTOM_VIEW = SESSION_TYPE_CUSTOM_VIEW
}
