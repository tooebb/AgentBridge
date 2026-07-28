package com.rokid.renewcxrlsample.utils

import android.util.Log

class SimpleLogger(val TAG : String) {
    fun logD(msg: String){
        Log.d(TAG, msg)
    }
    fun logE(msg: String){
        Log.e(TAG, msg)
    }
    fun logW(msg: String){
        Log.w(TAG, msg)
    }
    fun logI(msg: String){
        Log.i(TAG, msg)
    }
    fun logV(msg: String){
        Log.v(TAG, msg)
    }
    fun logA(msg: String){
        Log.wtf(TAG, msg)
    }
    fun log(msg: String){
        Log.println(Log.DEBUG, TAG, msg)
    }
    fun log(priority: Int, msg: String){
        Log.println(priority, TAG, msg)
    }
    fun log(priority: Int, tag: String, msg: String){
        Log.println(priority, tag, msg)
    }
}