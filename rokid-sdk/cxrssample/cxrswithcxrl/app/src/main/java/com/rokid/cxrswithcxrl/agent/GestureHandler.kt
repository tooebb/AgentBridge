package com.rokid.cxrswithcxrl.agent

import android.os.Handler
import android.os.Looper
import android.view.KeyEvent

class GestureHandler(
    private val onGesture: (actionType: String) -> Unit
) {
    private val clickHandler = Handler(Looper.getMainLooper())
    private var pendingSecondClick: Runnable? = null
    private var gestureLockUntil = 0L

    fun onKeyDown(keyCode: Int): Boolean {
        val now = System.currentTimeMillis()
        return when (keyCode) {
            KeyEvent.KEYCODE_NOTIFICATION -> {
                if (now < gestureLockUntil) return true
                val pending = pendingSecondClick
                if (pending != null) {
                    clickHandler.removeCallbacks(pending)
                    pendingSecondClick = null
                    onGesture(ACTION_REJECT)
                } else {
                    val singleClick = Runnable {
                        pendingSecondClick = null
                        onGesture(ACTION_APPROVE)
                    }
                    pendingSecondClick = singleClick
                    clickHandler.postDelayed(singleClick, CLICK_DEBOUNCE_MS)
                }
                true
            }

            KeyEvent.KEYCODE_DPAD_UP -> {
                if (now >= gestureLockUntil) {
                    pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
                    pendingSecondClick = null
                    gestureLockUntil = now + SWIPE_LOCK_MS
                    onGesture(ACTION_VIEW_DETAILS)
                }
                true
            }

            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (now >= gestureLockUntil) {
                    pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
                    pendingSecondClick = null
                    gestureLockUntil = now + SWIPE_LOCK_MS
                    onGesture(ACTION_SCREEN_OFF)
                }
                true
            }

            KeyEvent.KEYCODE_BACK -> {
                pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
                pendingSecondClick = null
                onGesture(ACTION_REJECT)
                true
            }

            else -> false
        }
    }

    fun onKeyUp(keyCode: Int): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> true
            else -> false
        }
    }

    fun destroy() {
        pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
        pendingSecondClick = null
    }

    companion object {
        private const val CLICK_DEBOUNCE_MS = 500L
        private const val SWIPE_LOCK_MS = 500L
        private const val ACTION_APPROVE = "approve"
        private const val ACTION_REJECT = "reject"
        private const val ACTION_VIEW_DETAILS = "view_details"
        private const val ACTION_SCREEN_OFF = "screen_off"
    }
}
