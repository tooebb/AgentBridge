package com.rokid.renewcxrlsample.utils

import androidx.lifecycle.ViewModel

open class BaseViewModel: ViewModel() {

    private val logger: SimpleLogger = SimpleLogger(this::class.java.simpleName)

    fun logD(msg: String) {
        logger.logD(msg)
    }
    fun logE(msg: String) {
        logger.logE(msg)
    }
    fun logW(msg: String) {
        logger.logW(msg)
    }
    fun logI(msg: String) {
        logger.logI(msg)
    }
    fun logV(msg: String) {
        logger.logV(msg)
    }
}