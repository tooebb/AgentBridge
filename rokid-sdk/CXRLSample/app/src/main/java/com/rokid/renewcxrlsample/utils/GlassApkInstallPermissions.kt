package com.rokid.renewcxrlsample.utils

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings

/**
 * Storage permission checks before reading [cxrL.apk] from shared external paths.
 * Mirrors [com.rokid.cxrlsample.activities.customAppType.CustomAppTypeActivity].
 */
object GlassApkInstallPermissions {

    fun needRequestReadExternalStoragePermission(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return false
        return activity.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
    }

    fun needRequestManageAllFilesAccessPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return !hasManageAllFilesAccessPermission()
    }

    fun hasManageAllFilesAccessPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
    }

    fun buildManageAllFilesAccessIntent(packageName: String): Intent {
        return Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:$packageName")
        )
    }

    /**
     * @return true when all required storage permissions are already granted.
     */
    fun hasInstallStorageAccess(activity: Activity): Boolean {
        return !needRequestManageAllFilesAccessPermission() &&
            !needRequestReadExternalStoragePermission(activity)
    }
}
