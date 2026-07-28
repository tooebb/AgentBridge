package com.rokid.renewcxrlsample.navigation

import android.app.Activity
import android.content.Intent
import com.rokid.renewcxrlsample.activities.main.MainActivity
import com.rokid.renewcxrlsample.activities.session.CxrSessionActivity
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.session.CxrSessionType
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

object CxrSceneNavigation {

    sealed interface Command {
        data object ToSessionTypeSelection : Command
        data object ToCustomAppScene : Command
    }

    private val _commands = MutableSharedFlow<Command>(extraBufferCapacity = 1)
    val commands: SharedFlow<Command> = _commands.asSharedFlow()

    fun requestToSessionTypeSelection() {
        _commands.tryEmit(Command.ToSessionTypeSelection)
    }

    fun requestToCustomAppScene() {
        _commands.tryEmit(Command.ToCustomAppScene)
    }
}

fun Activity.navigateToSessionTypeSelection(token: String?) {
    startActivity(
        Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            token?.let { putExtra(CONSTANT.EXTRA_TOKEN, it) }
        }
    )
    finishAffinity()
}

fun Activity.navigateToCustomAppScene(token: String?) {
    startActivity(
        Intent(this, CxrSessionActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(CONSTANT.EXTRA_SESSION_TYPE, CxrSessionType.CUSTOM_APP.wireValue)
            token?.let { putExtra(CONSTANT.EXTRA_TOKEN, it) }
        }
    )
    if (this !is CxrSessionActivity) {
        finish()
    }
}
