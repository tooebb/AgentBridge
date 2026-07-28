package com.rokid.renewcxrlsample.navigation

import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

fun ComponentActivity.observeCxrSceneNavigation(tokenProvider: () -> String?) {
    lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
            CxrSceneNavigation.commands.collect { command ->
                when (command) {
                    CxrSceneNavigation.Command.ToSessionTypeSelection ->
                        navigateToSessionTypeSelection(tokenProvider())
                    CxrSceneNavigation.Command.ToCustomAppScene ->
                        navigateToCustomAppScene(tokenProvider())
                }
            }
        }
    }
}
